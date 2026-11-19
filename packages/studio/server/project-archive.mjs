/**
 * 工程包（zip）读写 —— M58 起自己实现，M60 改成**流式 + zip64**。
 *
 * 为什么不用第三方库：仓库 dependencies 只有一条，为了打包背一个 zip 库不值当；
 * 而且这里只需要 store / deflate 两种方法，加中央目录与校验，自己写反而更好控。
 *
 * M60 的改动（本文件的核心）：
 * - **写**：不再把所有条目拼进一个 Buffer。逐条「写头 → 流式写数据 → 回填 CRC/长度」，
 *   峰值内存 ≈ 一个 256KB 块，而不是整个工程。
 * - **zip64**：单条 ≥4GB、条目数 >65535、中央目录偏移 ≥4GB 时，按规范写 zip64 扩展字段
 *   与 zip64 EOCD；`forceZip64` 让测试能用几 KB 的包走同一条分支。
 * - **读**：`readArchiveIndex` 只读尾部 EOCD + 中央目录，条目数据在解包时逐条流出来；
 *   解包不再 `readFile` 整个包。
 *
 * 口径不变：`manifest.json` 是唯一校验依据；条目名不安全 → 整包拒绝；`.film/history/**` 不打包。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw, inflateRawSync } from 'node:zlib';

export const ARCHIVE_VERSION = 1;

/** 打包时跳过的目录（相对工程根）：撤销快照与命名版本库都是内部存储，带上没意义。 */
const SKIP_PREFIXES = Object.freeze(['.film/history/', '.film/versions.git/', '.film/versions-backup/']);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** 流式读写的块大小：太小 syscall 多，太大占内存。 */
const CHUNK = 256 * 1024;

/* ── CRC32 ─────────────────────────────────────────────────────────────── */

/** @type {Uint32Array | null} */
let crcTable = null;

function table() {
  if (crcTable !== null) return crcTable;
  const next = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    next[i] = c >>> 0;
  }
  crcTable = next;
  return next;
}

/**
 * 增量 CRC32：`c` 传上一块的返回值，首块传 `0xffffffff`。
 * @param {number} c
 * @param {Buffer} buffer
 */
function crcUpdate(c, buffer) {
  const t = table();
  let state = c >>> 0;
  for (let i = 0; i < buffer.length; i += 1) state = (t[(state ^ (buffer[i] ?? 0)) & 0xff] ?? 0) ^ (state >>> 8);
  return state >>> 0;
}

/** @param {Buffer} buffer */
export function crc32(buffer) {
  return (crcUpdate(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

/* ── 时间 ─────────────────────────────────────────────────────────────── */

/**
 * DOS 时间（zip 用的是 1980 起的本地时间，秒只有 2 秒精度）。
 * @param {Date} date
 */
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/* ── 列文件 ───────────────────────────────────────────────────────────── */

/**
 * 列工程里要打包的文件（相对路径）。`film.html` 必须在，否则没有可打包的工程。
 * @param {string} projectDir
 * @returns {Promise<string[]>} 排序后的相对路径（用 `/` 分隔）
 */
export async function listProjectFiles(projectDir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function walk(rel) {
    const abs = path.join(projectDir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (SKIP_PREFIXES.some((prefix) => `${childRel}/`.startsWith(prefix))) continue;
        await walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(childRel);
    }
  }
  await walk('');
  if (!out.includes('film.html')) throw new Error('工程里没有 film.html，无法打包');
  return out.sort();
}

/* ── 写 zip（流式） ────────────────────────────────────────────────────── */

/** 已压缩过的媒体再 deflate 只是白烧 CPU（还可能变大）→ 按扩展名走 store。
 * @param {string} name
 */
function isCompressible(name) {
  return !/\.(mp4|m4v|mov|webm|mp3|wav|aac|png|jpg|jpeg|gif|webp)$/i.test(name);
}

/**
 * 一条条目的写入结果（中央目录要用）。
 * @typedef {{ name: string, method: number, crc: number, compressed: number, size: number, offset: number, zip64: boolean, sha256: string }} WrittenEntry
 */

/**
 * 边读边算：CRC + sha256 + 未压缩字节数。放在数据流的**前面**（deflate 之前）。
 * @param {{ crc: number, size: number, hash: import('node:crypto').Hash }} state
 */
function meter(state) {
  return new Transform({
    /** @param {Buffer} chunk @param {any} _enc @param {(error?: Error | null, data?: Buffer) => void} done */
    transform(chunk, _enc, done) {
      state.crc = crcUpdate(state.crc, chunk);
      state.size += chunk.length;
      state.hash.update(chunk);
      done(null, chunk);
    },
  });
}

/**
 * 顺序写入指定偏移的 Writable，顺便累计「压缩后字节数」。
 *
 * 不用 `FileHandle.createWriteStream`：在 `autoClose:false` + pipeline destroy 之后，
 * `handle.close()` 会永远 pending（实测会以「unsettled top-level await」静默退出）。
 * 这里每次显式给偏移，写完一段推进一段，和 handle 的生命周期彻底解耦。
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} start
 */
function positionalSink(handle, start) {
  let position = start;
  const state = { bytes: 0 };
  const stream = new Writable({
    /** @param {Buffer} chunk @param {any} _enc @param {(error?: Error | null) => void} done */
    write(chunk, _enc, done) {
      handle.write(chunk, 0, chunk.length, position).then(
        () => {
          position += chunk.length;
          state.bytes += chunk.length;
          done();
        },
        (error) => done(error),
      );
    },
  });
  return { stream, state };
}

/**
 * 写一条条目：头 → 数据（流式）→ 回填。
 *
 * 头里的 CRC/长度先留 0（zip64 条目留 0xFFFFFFFF），数据写完再按偏移回填——
 * 这样不需要 data descriptor（bit 3），老读取器也能读。
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {string} name
 * @param {{ source: AsyncIterable<Buffer>, declaredSize: number, method: number }} input
 * @param {{ offset: number, time: number, date: number, forceZip64: boolean }} ctx
 * @returns {Promise<WrittenEntry>}
 */
async function writeEntry(handle, name, input, ctx) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const zip64 = ctx.forceZip64 || input.declaredSize >= U32_MAX;
  // zip64 本地扩展：id(2) + size(2) + [未压缩(8) + 压缩(8)]，先留 0，写完回填。
  const extra = zip64 ? Buffer.alloc(4 + 16) : Buffer.alloc(0);
  if (zip64) {
    extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    extra.writeUInt16LE(16, 2);
  }

  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIG, 0);
  header.writeUInt16LE(zip64 ? 45 : 20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(input.method, 8);
  header.writeUInt16LE(ctx.time, 10);
  header.writeUInt16LE(ctx.date, 12);
  header.writeUInt32LE(zip64 ? U32_MAX : 0, 14); // crc，写完回填
  header.writeUInt32LE(zip64 ? U32_MAX : 0, 18); // 压缩后
  header.writeUInt32LE(zip64 ? U32_MAX : 0, 22); // 未压缩
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(extra.length, 28);

  const head = [header, nameBuffer, extra];
  await handle.write(Buffer.concat(head), 0, header.length + nameBuffer.length + extra.length, ctx.offset);
  const dataStart = ctx.offset + header.length + nameBuffer.length + extra.length;

  const state = { crc: 0xffffffff, size: 0, hash: createHash('sha256') };
  const sink = positionalSink(handle, dataStart);
  /** @type {any[]} */
  const stages = [input.source, meter(state)];
  if (input.method === 8) stages.push(createDeflateRaw({ level: 6 }));
  await pipeline([...stages, sink.stream]);

  const crc = (state.crc ^ 0xffffffff) >>> 0;
  const compressed = sink.state.bytes;
  const size = state.size;

  /** @type {Buffer} */
  const patch = Buffer.alloc(4);
  patch.writeUInt32LE(crc, 0);
  await handle.write(patch, 0, 4, ctx.offset + 14);
  if (zip64) {
    const sizes = Buffer.alloc(16);
    sizes.writeBigUInt64LE(BigInt(size), 0);
    sizes.writeBigUInt64LE(BigInt(compressed), 8);
    await handle.write(sizes, 0, 16, ctx.offset + 30 + nameBuffer.length + 4);
  } else {
    const lens = Buffer.alloc(8);
    lens.writeUInt32LE(compressed, 0);
    lens.writeUInt32LE(size, 4);
    await handle.write(lens, 0, 8, ctx.offset + 18);
  }

  return {
    name,
    method: input.method,
    crc,
    compressed,
    size,
    offset: ctx.offset,
    zip64,
    sha256: state.hash.digest('hex'),
  };
}

/**
 * 生成工程 zip（写到 `outPath`）。返回清单，调用方可以直接回给前端。
 *
 * @param {string} projectDir
 * @param {string} outPath
 * @param {{ name?: string, forceZip64?: boolean }} [options]
 */
export async function writeProjectArchive(projectDir, outPath, { name, forceZip64 = false } = {}) {
  const files = await listProjectFiles(projectDir);
  const now = new Date();
  const { time, date } = dosTime(now);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const handle = await fs.open(outPath, 'w');
  /** @type {WrittenEntry[]} */
  const written = [];
  /** @type {Array<{ path: string, bytes: number, sha256: string }>} */
  const manifestFiles = [];
  /** 下一条的本地头偏移：写完一条就把「头 + 名字 + 扩展 + 数据」加上去。 */
  let cursor = 0;
  try {
    for (const rel of files) {
      const abs = path.join(projectDir, rel);
      const stat = await fs.stat(abs);
      const entry = await writeEntry(
        handle,
        rel,
        {
          source: createReadStream(abs, { highWaterMark: CHUNK }),
          declaredSize: stat.size,
          method: isCompressible(rel) ? 8 : 0,
        },
        { offset: cursor, time, date, forceZip64 },
      );
      cursor += 30 + Buffer.byteLength(rel, 'utf8') + (entry.zip64 ? 20 : 0) + entry.compressed;
      written.push(entry);
      manifestFiles.push({ path: rel, bytes: entry.size, sha256: entry.sha256 });
    }

    // manifest.json 自己也是一条（清单里不列自己，避免自指）。
    const manifest = {
      version: ARCHIVE_VERSION,
      name: typeof name === 'string' && name !== '' ? name : path.basename(path.resolve(projectDir)),
      createdAt: now.toISOString(),
      skip: [...SKIP_PREFIXES],
      files: manifestFiles,
    };
    const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestEntry = await writeEntry(
      handle,
      'manifest.json',
      { source: Readable.from([manifestData]), declaredSize: manifestData.length, method: 8 },
      { offset: cursor, time, date, forceZip64 },
    );
    cursor += 30 + Buffer.byteLength('manifest.json', 'utf8') + (manifestEntry.zip64 ? 20 : 0) + manifestEntry.compressed;

    const all = [...written, manifestEntry];
    const centralOffset = cursor;

    /** @type {Buffer[]} */
    const centrals = [];
    let centralBytes = 0;
    for (const item of all) {
      const nameBuffer = Buffer.from(item.name, 'utf8');
      // 中央目录里的 zip64 扩展固定三段（未压缩 / 压缩 / 偏移），省得判哪几个是 0xFFFFFFFF。
      const extra = item.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
      if (item.zip64) {
        extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(item.size), 4);
        extra.writeBigUInt64LE(BigInt(item.compressed), 12);
        extra.writeBigUInt64LE(BigInt(item.offset), 20);
      }
      const central = Buffer.alloc(46);
      central.writeUInt32LE(CENTRAL_SIG, 0);
      central.writeUInt16LE(item.zip64 ? 45 : 20, 4);
      central.writeUInt16LE(item.zip64 ? 45 : 20, 6);
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(item.method, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(item.crc, 16);
      central.writeUInt32LE(item.zip64 ? U32_MAX : item.compressed, 20);
      central.writeUInt32LE(item.zip64 ? U32_MAX : item.size, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(item.zip64 ? U32_MAX : item.offset, 42);
      centrals.push(central, nameBuffer, extra);
      centralBytes += central.length + nameBuffer.length + extra.length;
    }
    const central = Buffer.concat(centrals);
    await handle.write(central, 0, central.length, centralOffset);

    const count = all.length;
    const needsZip64 =
      forceZip64 ||
      count > U16_MAX ||
      centralOffset >= U32_MAX ||
      centralBytes >= U32_MAX ||
      all.some((item) => item.zip64);

    let trailerOffset = centralOffset + centralBytes;
    if (needsZip64) {
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      z64.writeBigUInt64LE(44n, 4); // 本记录之后还有 44 字节
      z64.writeUInt16LE(45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(count), 24);
      z64.writeBigUInt64LE(BigInt(count), 32);
      z64.writeBigUInt64LE(BigInt(centralBytes), 40);
      z64.writeBigUInt64LE(BigInt(centralOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(trailerOffset), 8);
      locator.writeUInt32LE(1, 16);
      await handle.write(Buffer.concat([z64, locator]), 0, 76, trailerOffset);
      trailerOffset += 76;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needsZip64 ? U16_MAX : count, 8);
    eocd.writeUInt16LE(needsZip64 ? U16_MAX : count, 10);
    eocd.writeUInt32LE(needsZip64 ? U32_MAX : centralBytes, 12);
    eocd.writeUInt32LE(needsZip64 ? U32_MAX : centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await handle.write(eocd, 0, 22, trailerOffset);

    const bytes = trailerOffset + 22;
    await handle.truncate(bytes);
    return { ok: true, path: outPath, bytes, files: manifestFiles.length, manifest, zip64: needsZip64 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/* ── 读 zip（中央目录） ────────────────────────────────────────────────── */

/**
 * 在 buffer 里从尾部找 EOCD。
 * @param {Buffer} buffer
 */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解析中央目录（zip64 扩展在这里展开）。
 * @param {Buffer} buffer 中央目录本身
 * @param {number} count
 * @returns {{ ok: true, entries: Array<{ name: string, method: number, crc: number, size: number, compressed: number, localOffset: number }> } | { ok: false, code: string, message: string }}
 */
function parseCentral(buffer, count) {
  /** @type {Array<{ name: string, method: number, crc: number, size: number, compressed: number, localOffset: number }>} */
  const entries = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      return { ok: false, code: 'ARCHIVE_CORRUPT', message: '中央目录损坏' };
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    let compressed = buffer.readUInt32LE(cursor + 20);
    let size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // zip64 扩展：顺序固定（未压缩 / 压缩 / 偏移），只为 0xFFFFFFFF 的字段取值。
    let extraAt = cursor + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extraAt);
      const len = buffer.readUInt16LE(extraAt + 2);
      if (id === ZIP64_EXTRA_ID) {
        let at = extraAt + 4;
        if (size === U32_MAX && at + 8 <= extraAt + 4 + len) {
          size = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (compressed === U32_MAX && at + 8 <= extraAt + 4 + len) {
          compressed = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (localOffset === U32_MAX && at + 8 <= extraAt + 4 + len) {
          localOffset = Number(buffer.readBigUInt64LE(at));
        }
        break;
      }
      extraAt += 4 + len;
    }

    entries.push({ name, method, crc, size, compressed, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { ok: true, entries };
}

/**
 * 从 EOCD（可能带 zip64）里读出「条目数 / 中央目录大小 / 中央目录偏移」。
 *
 * `base` 是 buffer[0] 在文件里的绝对偏移：`readArchiveIndex` 只读尾部切片，
 * 而 zip64 locator 里存的是**文件绝对偏移**，不减 base 会把切片当成整包（zip64 EOCD 损坏）。
 * 返回的 centralOffset/centralSize 仍是绝对量，调用方按需自己定位。
 *
 * @param {Buffer} buffer
 * @param {number} eocd
 * @param {number} [base]
 * @returns {{ ok: true, count: number, centralSize: number, centralOffset: number } | { ok: false, code: string, message: string }}
 */
function centralInfo(buffer, eocd, base = 0) {
  let count = buffer.readUInt16LE(eocd + 10);
  let centralSize = buffer.readUInt32LE(eocd + 12);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count !== U16_MAX && centralSize !== U32_MAX && centralOffset !== U32_MAX) {
    return { ok: true, count, centralSize, centralOffset };
  }
  const locator = eocd - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) {
    return { ok: false, code: 'ARCHIVE_CORRUPT', message: 'zip64 定位记录缺失' };
  }
  const z64 = Number(buffer.readBigUInt64LE(locator + 8));
  const z64Local = z64 - base;
  if (z64Local < 0 || z64Local + 56 > buffer.length || buffer.readUInt32LE(z64Local) !== ZIP64_EOCD_SIG) {
    return { ok: false, code: 'ARCHIVE_CORRUPT', message: 'zip64 EOCD 损坏' };
  }
  count = Number(buffer.readBigUInt64LE(z64Local + 32));
  centralSize = Number(buffer.readBigUInt64LE(z64Local + 40));
  centralOffset = Number(buffer.readBigUInt64LE(z64Local + 48));
  return { ok: true, count, centralSize, centralOffset };
}

/**
 * 解析 zip（只读中央目录，不进文件系统）。
 * @param {Buffer} buffer
 * @returns {{ ok: true, entries: Array<{ name: string, method: number, size: number, data: Buffer }> } | { ok: false, code: string, message: string }}
 */
export function readZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) return { ok: false, code: 'ARCHIVE_NOT_ZIP', message: '不是 zip（找不到 EOCD）' };
  const info = centralInfo(buffer, eocd);
  if (info.ok !== true) return info;
  if (info.centralOffset + info.centralSize > buffer.length) {
    return { ok: false, code: 'ARCHIVE_CORRUPT', message: '中央目录越界' };
  }
  const parsed = parseCentral(
    buffer.subarray(info.centralOffset, info.centralOffset + info.centralSize),
    info.count,
  );
  if (parsed.ok !== true) return parsed;

  /** @type {Array<{ name: string, method: number, size: number, data: Buffer }>} */
  const entries = [];
  for (const item of parsed.entries) {
    const localOffset = item.localOffset;
    if (localOffset + 30 > buffer.length) {
      return { ok: false, code: 'ARCHIVE_CORRUPT', message: `条目 ${item.name} 头越界` };
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + item.compressed);
    if (raw.length !== item.compressed) {
      return { ok: false, code: 'ARCHIVE_CORRUPT', message: `条目 ${item.name} 数据被截断` };
    }
    let data;
    try {
      data = item.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    } catch {
      return { ok: false, code: 'ARCHIVE_CORRUPT', message: `条目 ${item.name} 解压失败` };
    }
    if (data.length !== item.size || crc32(data) !== item.crc) {
      return { ok: false, code: 'ARCHIVE_CHECKSUM', message: `条目 ${item.name} 校验不通过` };
    }
    entries.push({ name: item.name, method: item.method, size: item.size, data });
  }
  return { ok: true, entries };
}

/**
 * 只读「索引」：尾部 EOCD + 中央目录，不碰条目数据。
 *
 * 解包时用它做安全校验与清单读取，然后按条目偏移逐条流出——一个 4GB 的包
 * 不需要 4GB 内存。
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @returns {Promise<{ ok: true, size: number, entries: Array<{ name: string, method: number, crc: number, size: number, compressed: number, localOffset: number }> }
 *   | { ok: false, code: string, message: string }>}
 */
export async function readArchiveIndex(handle) {
  const stat = await handle.stat();
  const tailLength = Math.min(stat.size, 65557 + 76);
  const tailStart = stat.size - tailLength;
  const tail = Buffer.alloc(tailLength);
  await handle.read(tail, 0, tailLength, tailStart);

  const eocdAt = findEocd(tail);
  if (eocdAt < 0) return { ok: false, code: 'ARCHIVE_NOT_ZIP', message: '不是 zip（找不到 EOCD）' };
  const info = centralInfo(tail, eocdAt, tailStart);
  if (info.ok !== true) return info;

  const central = Buffer.alloc(info.centralSize);
  if (info.centralSize > 0) await handle.read(central, 0, info.centralSize, info.centralOffset);
  const parsed = parseCentral(central, info.count);
  if (parsed.ok !== true) return parsed;
  return { ok: true, size: stat.size, entries: parsed.entries };
}

/**
 * 读 zip 文件并解析清单。
 * @param {string} zipPath
 * @returns {Promise<
 *   | { ok: true, manifest: any, entries: Array<{ name: string, method: number, size: number, data: Buffer }>, bytes: number }
 *   | { ok: false, code: string, message: string }>}
 */
export async function readProjectArchive(zipPath) {
  return parseArchiveBuffer(await fs.readFile(zipPath));
}

/**
 * 同上，但直接吃 buffer。
 * @param {Buffer} buffer
 * @returns {{ ok: true, manifest: any, entries: Array<{ name: string, method: number, size: number, data: Buffer }>, bytes: number }
 *   | { ok: false, code: string, message: string }}
 */
export function parseArchiveBuffer(buffer) {
  const parsed = readZip(buffer);
  if (parsed.ok !== true) return parsed;
  return withManifest(parsed.entries, buffer.length);
}

/**
 * 从已解出的条目里取 manifest 并校验版本。
 * @param {Array<{ name: string, method: number, size: number, data: Buffer }>} entries
 * @param {number} bytes
 * @returns {{ ok: true, manifest: any, entries: Array<{ name: string, method: number, size: number, data: Buffer }>, bytes: number }
 *   | { ok: false, code: string, message: string }}
 */
function withManifest(entries, bytes) {
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  if (manifestEntry === undefined) {
    return { ok: false, code: 'ARCHIVE_NO_MANIFEST', message: '包里没有 manifest.json（不是本产品导出的工程包）' };
  }
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    return { ok: false, code: 'ARCHIVE_MANIFEST_BROKEN', message: 'manifest.json 不是合法 JSON' };
  }
  if (manifest?.version !== ARCHIVE_VERSION || !Array.isArray(manifest?.files)) {
    return {
      ok: false,
      code: 'ARCHIVE_MANIFEST_UNSUPPORTED',
      message: `manifest 版本不支持（需要 ${String(ARCHIVE_VERSION)}）`,
    };
  }
  return { ok: true, manifest, entries, bytes };
}

/* ── 解包 ─────────────────────────────────────────────────────────────── */

/**
 * 条目名是否安全（相对、无 `..`、无盘符、无反斜杠）。
 * @param {string} name
 */
export function isSafeEntryName(name) {
  if (name === '' || name.startsWith('/') || name.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * 读一条条目的数据起点（本地头可能带 zip64 扩展，长度不一定和中央目录一致）。
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} localOffset
 */
async function localDataStart(handle, localOffset) {
  const head = Buffer.alloc(30);
  await handle.read(head, 0, 30, localOffset);
  if (head.readUInt32LE(0) !== LOCAL_SIG) return -1;
  return localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

/**
 * 把一条条目流式解到磁盘，边解边算 CRC 与 sha256。
 * @returns {Promise<{ ok: true, sha256: string, bytes: number } | { ok: false, code: string, message: string }>}
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {{ name: string, method: number, crc: number, size: number, compressed: number, localOffset: number }} entry
 * @param {string} target
 */
async function extractEntry(handle, entry, target) {
  const dataStart = await localDataStart(handle, entry.localOffset);
  if (dataStart < 0) return { ok: false, code: 'ARCHIVE_CORRUPT', message: `条目 ${entry.name} 本地头损坏` };
  const state = { crc: 0xffffffff, size: 0, hash: createHash('sha256') };
  const input = handle.createReadStream({
    start: dataStart,
    end: dataStart + Math.max(0, entry.compressed) - 1,
    autoClose: false,
    highWaterMark: CHUNK,
  });
  /** @type {any[]} */
  const stages = [input];
  if (entry.method === 8) stages.push(createInflateRaw());
  stages.push(meter(state));

  const out = createWriteStream(target);
  try {
    await pipeline([...stages, out]);
  } catch (error) {
    await fs.rm(target, { force: true });
    return { ok: false, code: 'ARCHIVE_CORRUPT', message: `条目 ${entry.name} 解压失败：${String(error)}` };
  }

  const crc = (state.crc ^ 0xffffffff) >>> 0;
  if (state.size !== entry.size || crc !== entry.crc) {
    await fs.rm(target, { force: true });
    return { ok: false, code: 'ARCHIVE_CHECKSUM', message: `条目 ${entry.name} 校验不通过` };
  }
  return { ok: true, sha256: state.hash.digest('hex'), bytes: state.size };
}

/**
 * 解包到空目录，并按 manifest 复核每个文件的 sha256。
 *
 * M60：不再整包读进内存——只读中央目录，条目数据逐条流到磁盘。
 *
 * @param {string} zipPath
 * @param {string} targetDir
 * @returns {Promise<{ ok: true, dir: string, files: number, manifest: any,
 *   mismatch: Array<{ path: string, reason: string }>, extra: string[] } | { ok: false, code: string, message: string }>}
 */
export async function extractProjectArchive(zipPath, targetDir) {
  const handle = await fs.open(zipPath, 'r').catch((error) => {
    /** @type {any} */ const cause = error;
    return cause?.code === 'ENOENT' ? null : Promise.reject(error);
  });
  if (handle === null) {
    return { ok: false, code: 'ARCHIVE_UNREADABLE', message: `工程包不存在：${zipPath}` };
  }

  try {
    const index = await readArchiveIndex(handle);
    if (index.ok !== true) return { ok: false, code: index.code, message: index.message };

    // 先整体校验条目名，有一条越界就整包拒绝——不要「写得进的就写」。
    // 顺序刻意放在「有没有 manifest」之前：路径穿越是结构性问题，先挡住再说。
    for (const entry of index.entries) {
      if (!isSafeEntryName(entry.name)) {
        return { ok: false, code: 'ARCHIVE_UNSAFE_PATH', message: `包里条目路径不安全：${entry.name}` };
      }
    }

    const manifestEntry = index.entries.find((entry) => entry.name === 'manifest.json');
    if (manifestEntry === undefined) {
      return { ok: false, code: 'ARCHIVE_NO_MANIFEST', message: '包里没有 manifest.json（不是本产品导出的工程包）' };
    }
    if (!index.entries.some((entry) => entry.name === 'film.html')) {
      return { ok: false, code: 'ARCHIVE_NO_FILM', message: '包里没有 film.html' };
    }

    await fs.mkdir(targetDir, { recursive: true });
    /** @type {Array<{ path: string, reason: string }>} */
    const mismatch = [];
    /** @type {string[]} */
    const extra = [];

    // manifest 要**先**解出来：条目按名字排序，manifest.json 排最后，先解数据会把所有文件
    // 判成「清单里没有」（M58 的 extra 语义就废了）。
    const manifestTarget = path.join(targetDir, 'manifest.json');
    const manifestGot = await extractEntry(handle, manifestEntry, manifestTarget);
    if (manifestGot.ok !== true) return { ok: false, code: manifestGot.code, message: manifestGot.message };
    /** @type {any} */
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestTarget, 'utf8'));
    } catch {
      return { ok: false, code: 'ARCHIVE_MANIFEST_BROKEN', message: 'manifest.json 不是合法 JSON' };
    }
    if (manifest?.version !== ARCHIVE_VERSION || !Array.isArray(manifest?.files)) {
      return {
        ok: false,
        code: 'ARCHIVE_MANIFEST_UNSUPPORTED',
        message: `manifest 版本不支持（需要 ${String(ARCHIVE_VERSION)}）`,
      };
    }

    for (const entry of index.entries) {
      if (entry.name === 'manifest.json') continue;
      const target = path.join(targetDir, entry.name);
      const resolved = path.resolve(target);
      if (resolved !== path.resolve(targetDir) && !resolved.startsWith(`${path.resolve(targetDir)}${path.sep}`)) {
        return { ok: false, code: 'ARCHIVE_UNSAFE_PATH', message: `条目逃出目标目录：${entry.name}` };
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const got = await extractEntry(handle, entry, target);
      if (got.ok !== true) return { ok: false, code: got.code, message: got.message };

      const expected = manifest.files.find((/** @type {any} */ item) => item.path === entry.name);
      if (expected === undefined) {
        extra.push(entry.name);
      } else if (expected.sha256 !== got.sha256) {
        mismatch.push({ path: entry.name, reason: 'sha256 与清单不一致' });
      }
    }

    // 反向：清单里有、包里没有。这条在 M60 重写时漏过一次（单测 56 抓住的），
    // 漏了的话「少打包一个文件」会被当成完全成功。
    const present = new Set(index.entries.map((entry) => entry.name));
    for (const item of manifest.files) {
      if (!present.has(item.path)) mismatch.push({ path: item.path, reason: '清单里有，包里没有' });
    }

    return { ok: true, dir: targetDir, files: index.entries.length - 1, manifest, mismatch, extra };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
