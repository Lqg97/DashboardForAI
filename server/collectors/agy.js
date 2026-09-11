// agy = Google Antigravity CLI (Gemini 生态), 数据在 ~/.gemini/antigravity-cli/
// 会话数据库位于 ~/.gemini/antigravity-cli/conversations/*.db
// 日志与转录位于 ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGY_DIR } from "../config.js";
import { costOf } from "../pricing-chain.js";

function parseProtobuf(buffer) {
  let pos = 0;
  const fields = [];
  while (pos < buffer.length) {
    const key = buffer[pos++];
    const wireType = key & 0x07;
    const fieldNum = key >> 3;
    if (wireType === 0) {
      let val = 0n,
        shift = 0n;
      while (pos < buffer.length) {
        const b = BigInt(buffer[pos++]);
        val |= (b & 0x7fn) << shift;
        if ((b & 0x80n) === 0n) break;
        shift += 7n;
      }
      fields.push({ fieldNum, wireType, val: Number(val) });
    } else if (wireType === 2) {
      let len = 0,
        shift = 0;
      while (pos < buffer.length) {
        const b = buffer[pos++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const slice = buffer.slice(pos, pos + len);
      pos += len;
      fields.push({ fieldNum, wireType, val: slice });
    } else if (wireType === 1) pos += 8;
    else if (wireType === 5) pos += 4;
    else break;
  }
  return fields;
}
// 会话所属工作区: trajectory_metadata_blob(id='main') 里存着 file:///<workspace>
// 拿不到时回退为会话 id(不凭空猜测)
function readWorkspacePath(db) {
  try {
    const row = db
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
      .get();
    if (!row || !row.data) return null;
    // 只取路径合法字符: blob 里可能前后紧挨多个 file:// 条目或二进制字节,
    // 宽字符集会把 `.../src>file:///...` 这类内容一起吞进来
    const m = Buffer.from(row.data)
      .toString("utf8")
      .match(/file:\/\/([A-Za-z0-9_\-./%~]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function collect(opts = {}) {
  const dir = opts.dir || AGY_DIR;
  if (!existsSync(dir)) return [];
  const convDir = join(dir, "conversations");
  const brainDir = join(dir, "brain");
  if (!existsSync(convDir)) return [];

  const pricingOverrides = opts.pricingOverrides || {};
  const unpricedModels = opts.unpricedModels || new Set();

  const events = [];
  let dbFiles;
  try {
    dbFiles = readdirSync(convDir).filter((f) => f.endsWith(".db"));
  } catch {
    return [];
  }

  for (const dbFile of dbFiles) {
    const convId = dbFile.replace(/\.db$/, "");
    const dbPath = join(convDir, dbFile);
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      continue;
    }

    try {
      // 提取 transcript 中的时间戳映射 (step_index -> created_at ms)
      const stepTimes = new Map();
      const transPath = join(
        brainDir,
        convId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      let fallbackTs = Date.now();
      try {
        fallbackTs = statSync(dbPath).mtimeMs;
      } catch {}

      if (existsSync(transPath)) {
        try {
          const lines = readFileSync(transPath, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.step_index !== undefined && obj.created_at) {
              stepTimes.set(obj.step_index, Date.parse(obj.created_at));
            }
          }
        } catch {}
      }

      const gRows = db
        .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC")
        .all();
      const workspace = readWorkspacePath(db);
      // 同一会话内模型通常不变: 某几行解析不到时沿用上一个已知模型,
      // 而不是套用全局默认(那会把 3.8 的请求错标成 3.7 并按错的价格计费)
      let lastModel = null;
      for (const gr of gRows) {
        if (!gr.data) continue;
        const buf = Buffer.from(gr.data);
        const top = parseProtobuf(buf);
        const strBuf = buf.toString("utf8");

        // 模型名称解析
        let model = null;
        const mMatch = strBuf.match(/gemini-[a-zA-Z0-9.-]+/i);
        if (mMatch) model = mMatch[0].replace(/[.-]+$/, "");
        if (!model && lastModel) model = lastModel;
        if (model) lastModel = model;
        else model = "gemini-unknown";

        // 步数与时间戳
        let stepIdx = gr.idx * 2;
        const sMatch = strBuf.match(/last_step_index\s*(\d+)/);
        if (sMatch) stepIdx = parseInt(sMatch[1], 10);

        const ts =
          stepTimes.get(stepIdx) ||
          stepTimes.get(stepIdx + 1) ||
          stepTimes.get(stepIdx - 1) ||
          fallbackTs - (gRows.length - gr.idx) * 10000;

        // 提取 prompt_tokens, output_tokens, cached_tokens
        const f1 = top.find((x) => x.fieldNum === 1);
        if (f1 && Buffer.isBuffer(f1.val)) {
          const sub = parseProtobuf(f1.val);
          const f4 = sub.find((x) => x.fieldNum === 4);
          if (f4 && Buffer.isBuffer(f4.val)) {
            const subUsage = parseProtobuf(f4.val);
            const inT = subUsage.find((x) => x.fieldNum === 2)?.val || 0;
            const outT = subUsage.find((x) => x.fieldNum === 3)?.val || 0;
            const cacheT = subUsage.find((x) => x.fieldNum === 5)?.val || 0;

            const ev = {
              agent: "agy",
              ts: Number.isFinite(ts) ? ts : Date.now(),
              model,
              project: workspace || convId,
              inputTokens: inT,
              outputTokens: outT,
              cacheReadTokens: cacheT,
              cacheWriteTokens: 0,
              costUSD: 0,
            };
            const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
            ev.costUSD = cost;
            if (unpriced) unpricedModels.add(ev.model);
            events.push(ev);
          }
        }
      }
    } catch {
      // ignore corrupted db
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}
