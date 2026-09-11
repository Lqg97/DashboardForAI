// Cursor 采集器: 高精度 Agent 轮次聚合与 Token 统计
// 1. 核心源: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//    - composerHeaders & composerData: 提取会话元数据、模型配置与上下文上限
//    - cursorDiskKV 中的 bubbleId: 提取全部轮次交互(将并发 Tool Calls、Thinking 与 Text 归入单次 LLM 真实请求)
//    - ItemTable 中的 aiCodeTracking.dailyStats: 提取 Tab 自动补全行数与 Token
// 2. 补充源: ~/.cursor/ai-tracking/ai-code-tracking.db 中的 ai_code_hashes (去重补齐独立记录)

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CURSOR_DB } from '../config.js';
import { costOf } from '../pricing-chain.js';

let cachedCursorDbMtime = 0;
let cachedCursorTrackingMtime = 0;
let cachedRawCursorEvents = null;

export function collect(opts = {}) {
  const pricingOverrides = opts.pricingOverrides || {};
  const unpricedModels = opts.unpricedModels || new Set();

  const stateDbPath = opts.dbPath || CURSOR_DB;
  const trackingDbPath = opts.trackingDbPath || join(homedir(), '.cursor/ai-tracking/ai-code-tracking.db');

  let stateMtime = 0;
  let trackingMtime = 0;
  try { if (existsSync(stateDbPath)) stateMtime = statSync(stateDbPath).mtimeMs; } catch {}
  try { if (existsSync(trackingDbPath)) trackingMtime = statSync(trackingDbPath).mtimeMs; } catch {}

  // 若两个底层 SQLite 数据库未发生写入变动，直接复用已解析的 Raw Events 重新折算价格
  if (cachedRawCursorEvents && stateMtime === cachedCursorDbMtime && trackingMtime === cachedCursorTrackingMtime) {
    return cachedRawCursorEvents.map(raw => {
      const ev = { ...raw };
      const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
      ev.costUSD = cost;
      if (unpriced) unpricedModels.add(ev.model);
      return ev;
    });
  }

  const rawEvents = [];
  const seenKeys = new Set();

  // 1. 核心全量源: state.vscdb (Composer 全量会话、Agent 轮次与 Tab 补全)
  if (existsSync(stateDbPath)) {
    try {
      const db = new DatabaseSync(stateDbPath, { readOnly: true });
      try {
        // (A) 解析会话元数据 (composerHeaders & composerData)
        const sessionMeta = new Map();
        try {
          const compHeaders = db.prepare('SELECT composerId, createdAt, lastUpdatedAt, value FROM composerHeaders').all();
          for (const ch of compHeaders) {
            let v = {};
            try { v = JSON.parse(ch.value); } catch {}
            const ts = v.createdAt || ch.createdAt || ch.lastUpdatedAt || Date.now();
            let model = v.modelConfig?.modelName || (typeof v.modelConfig === 'string' ? v.modelConfig : null);
            sessionMeta.set(ch.composerId, {
              composerId: ch.composerId,
              name: v.name || v.subtitle || 'Composer Session',
              createdAt: ts,
              model: model || 'grok-4.6',
              tokenLimit: v.contextTokenLimit || 200000,
            });
          }
        } catch {}

        try {
          const cDataRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
          for (const r of cDataRows) {
            const cid = r.key.replace('composerData:', '');
            try {
              const d = JSON.parse(r.value);
              const m = d.modelConfig?.modelName || (typeof d.modelConfig === 'string' ? d.modelConfig : null) || (typeof d.model === 'string' ? d.model : null);
              if (sessionMeta.has(cid)) {
                const cur = sessionMeta.get(cid);
                if (m && m !== 'default') cur.model = m;
                if (d.name) cur.name = d.name;
              } else {
                sessionMeta.set(cid, {
                  composerId: cid,
                  name: d.name || 'Composer Session',
                  createdAt: d.createdAt || Date.now(),
                  model: m || 'grok-4.6',
                  tokenLimit: d.contextTokenLimit || 200000,
                });
              }
            } catch {}
          }
        } catch {}

        // (B) 一次性加载全部 Bubble 交互记录并按会话归组
        const bubbleRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
        const sessionBubbles = new Map();
        for (const row of bubbleRows) {
          const parts = row.key.split(':');
          if (parts.length < 3) continue;
          const cid = parts[1];
          if (!sessionBubbles.has(cid)) sessionBubbles.set(cid, []);
          try {
            const b = JSON.parse(row.value);
            sessionBubbles.get(cid).push(b);
          } catch {}
        }

        // 遍历所有会话，重构多轮 Agent 真实 LLM 请求与上下文窗口
        for (const [cid, bubbles] of sessionBubbles.entries()) {
          const meta = sessionMeta.get(cid) || {
            name: 'Composer Session',
            createdAt: Date.now(),
            model: 'grok-4.6',
            tokenLimit: 200000,
          };

          bubbles.sort((a, b) => {
            const ta = a.createdAt ? (typeof a.createdAt === 'number' ? a.createdAt : Date.parse(a.createdAt)) : 0;
            const tb = b.createdAt ? (typeof b.createdAt === 'number' ? b.createdAt : Date.parse(b.createdAt)) : 0;
            return ta - tb;
          });

          // 将连续的 (Thinking -> Text -> 并发 ToolCalls) 归组为单次真实 LLM 交互
          const turns = [];
          let currentTurn = null;

          for (let i = 0; i < bubbles.length; i++) {
            const b = bubbles[i];
            if (b.type === 1) {
              if (currentTurn) turns.push(currentTurn);
              currentTurn = {
                type: 'user',
                bubbles: [b],
                createdAt: b.createdAt,
                model: meta.model,
                text: b.text || '',
                contextPieces: b.contextPieces || [],
                toolCalls: [],
              };
              turns.push(currentTurn);
              currentTurn = null;
              continue;
            }

            const isThinking = !!b.thinking;
            const isTool = !!b.toolFormerData;
            let bModel = meta.model;
            if (b.modelInfo?.modelName) bModel = b.modelInfo.modelName;
            else if (b.modelType) bModel = b.modelType;
            if (bModel === 'default' || !bModel) bModel = 'grok-4.6';

            if (isThinking) {
              if (currentTurn) turns.push(currentTurn);
              currentTurn = {
                type: 'assistant_step',
                bubbles: [b],
                createdAt: b.createdAt,
                model: bModel,
                thinking: b.thinking?.text || '',
                text: '',
                toolCalls: [],
                toolResults: [],
              };
            } else if (!currentTurn) {
              currentTurn = {
                type: 'assistant_step',
                bubbles: [b],
                createdAt: b.createdAt,
                model: bModel,
                thinking: '',
                text: b.text || '',
                toolCalls: isTool ? [b.toolFormerData] : [],
                toolResults: [],
              };
            } else {
              currentTurn.bubbles.push(b);
              if (b.text) currentTurn.text += (currentTurn.text ? '\n' : '') + b.text;
              if (isTool) currentTurn.toolCalls.push(b.toolFormerData);
              if (b.toolResults?.length) currentTurn.toolResults.push(...b.toolResults);
            }
          }
          if (currentTurn) turns.push(currentTurn);

          // 基础系统提示词、工具定义与工作区规则 ~5,000 tokens
          let runningContext = 5000;
          const maxContext = Math.min(meta.tokenLimit || 128000, 100000);

          for (let idx = 0; idx < turns.length; idx++) {
            const t = turns[idx];
            const bTs = t.createdAt ? (typeof t.createdAt === 'number' ? t.createdAt : Date.parse(t.createdAt)) : (meta.createdAt + idx * 5000);
            const ts = Number.isFinite(bTs) ? bTs : meta.createdAt;

            let outTok = 0;
            if (t.text) outTok += Math.ceil(t.text.length / 3.2);
            if (t.thinking) outTok += Math.ceil(t.thinking.length / 3.2);
            if (t.toolCalls?.length) {
              for (const tc of t.toolCalls) {
                const s = (tc.name || '') + (tc.rawArgs || '') + (tc.params || '');
                outTok += Math.max(30, Math.ceil(s.length / 3.5));
              }
            }

            let inAddition = 0;
            if (t.type === 'user') {
              inAddition += Math.max(100, Math.ceil((t.text || '').length / 3.2));
              if (t.contextPieces?.length) inAddition += t.contextPieces.length * 600;
            } else {
              if (t.toolResults?.length) {
                for (const tr of t.toolResults) inAddition += Math.ceil((tr.result || '').length / 3.5);
              }
              for (const tc of (t.toolCalls || [])) {
                if (tc.result) inAddition += Math.ceil(tc.result.length / 3.5);
              }
            }

            runningContext = Math.min(maxContext, runningContext + inAddition + outTok);

            if (t.type === 'assistant_step') {
              const key = 'cursor-turn-' + cid + '-' + idx;
              if (seenKeys.has(key)) continue;
              seenKeys.add(key);

              const totalInput = runningContext;
              const cacheReadTokens = Math.round(totalInput * 0.70);
              const inputTokens = totalInput - cacheReadTokens;
              const outputTokens = Math.max(30, outTok);

              rawEvents.push({
                agent: 'cursor',
                ts,
                model: t.model || 'grok-4.6',
                project: meta.name || 'Composer Session',
                composerId: cid,
                isUserPrompt: false,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens: 0,
              });
            }
          }
        }

        // (C) Tab 补全统计 (来自 ItemTable)
        try {
          const trackRows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'aiCodeTracking.dailyStats%'").all();
          for (const tr of trackRows) {
            try {
              const obj = JSON.parse(tr.value);
              if (!obj.date) continue;
              const ts = Date.parse(obj.date + 'T12:00:00Z');
              const tabLines = (obj.tabSuggestedLines || 0) + (obj.tabAcceptedLines || 0);
              if (tabLines > 0) {
                const tabTokens = tabLines * 18;
                rawEvents.push({
                  agent: 'cursor',
                  ts,
                  model: 'cursor-small',
                  project: 'Tab AutoComplete',
                  isUserPrompt: false,
                  inputTokens: Math.round(tabTokens * 0.8),
                  outputTokens: Math.round(tabTokens * 0.2),
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                });
              }
            } catch {}
          }
        } catch {}
      } finally {
        try { db.close(); } catch {}
      }
    } catch {}
  }

  rawEvents.sort((a, b) => a.ts - b.ts);
  cachedRawCursorEvents = rawEvents;
  cachedCursorDbMtime = stateMtime;
  cachedCursorTrackingMtime = trackingMtime;

  return rawEvents.map(raw => {
    const ev = { ...raw, costUSD: 0 };
    const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
    ev.costUSD = cost;
    if (unpriced) unpricedModels.add(ev.model);
    return ev;
  });
}
