import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { VOLUME_MAX, clampVolume, dbToVolume, effectiveFade } from '../../film-core/audio-edit.mjs';
import { isClipDisabled } from '../../film-core/clip-state.mjs';
import { findClipOf } from '../../film-core/track-audio.mjs';
import { atempoChain } from '../../render/audio-mix.mjs';
import { resolveFfmpegPath } from '../../render/ffmpeg.mjs';
import { LOUDNESS_PRESETS, TP_HEADROOM_DB, UNMEASURABLE_LUFS, parseLoudnormJson } from '../../render/loudness.mjs';
import { checkRelPath, isInside } from './project-file.mjs';

const run = promisify(execFile);
// The same file containers accepted in film.html. Disallow playlist/manifest demuxers
// and network protocols when the analysis is invoked through Studio.
const MEDIA_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,mp3,wav,aac,flac,ogg'];

/** @param {number} value */
const roundDb = (value) => Math.round(value * 100) / 100;

/** @param {string} code @param {string} message @param {number} [status] */
const reject = (code, message, status = 400) => /** @type {const} */ ({ ok: false, code, message, status });

/**
 * Measure a single active clip at unity gain, then plan a reversible volume adjustment.
 * Never writes to media or project files. The caller commits against the measured revision.
 * @param {{ doc: any, projectDir: string, clipId: string, preset: 'streaming'|'broadcast', signal: AbortSignal }} input
 */
export async function planClipLoudness({ doc, projectDir, clipId, preset, signal }) {
  const target = findClipOf(doc, clipId);
  if (!target) return reject('NOT_FOUND', '所选片段不存在', 404);
  const { track, clip } = target;
  if (track.locked) return reject('LOCKED', '所选片段的轨道已锁定');
  if (clip.kind !== 'sound' && clip.kind !== 'video') return reject('NO_AUDIO', '所选片段没有可分析的音频');
  if (track.hidden || track.muted || clip.muted || isClipDisabled(clip)) {
    return reject('CLIP_AUDIO_INACTIVE', '请先启用片段与轨道的声音');
  }
  const relative = checkRelPath(clip.src);
  if (!relative.ok) return reject(relative.code, '所选片段的素材路径无效');
  let file;
  try {
    const root = await realpath(projectDir);
    file = await realpath(path.join(root, relative.rel));
    if (!isInside(root, file)) return reject('E_PATH_ESCAPE', '素材指向工程目录之外');
    if (!(await stat(file)).isFile()) return reject('MEDIA_MISSING', '找不到所选片段的素材', 404);
  } catch {
    return reject('MEDIA_MISSING', '找不到所选片段的素材', 404);
  }

  const binary = await resolveFfmpegPath();
  if (!binary.found) return reject('CODEC_UNAVAILABLE', 'FFmpeg 不可用，无法测量片段响度', 503);
  const options = { signal, maxBuffer: 1_048_576, killSignal: /** @type {const} */ ('SIGKILL') };
  let media;
  try {
    const probe = await run('ffprobe', [
      '-v', 'error', ...MEDIA_INPUT, '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', file,
    ], options);
    media = JSON.parse(probe.stdout);
  } catch (error) {
    if (signal.aborted) return reject('CANCELLED', '响度测量已取消或超时', 408);
    if (/** @type {any} */ (error)?.code === 'ENOENT') return reject('CODEC_UNAVAILABLE', 'FFprobe 不可用，无法读取素材', 503);
    return reject('AUDIO_DECODE_FAILED', '无法读取素材中的音频流');
  }
  const audio = Array.isArray(media.streams) ? media.streams.find((/** @type {any} */ stream) => stream.codec_type === 'audio') : null;
  if (!audio) return reject('NO_AUDIO', '所选素材没有音频流');
  const start = Number(clip.time?.[0] ?? 0);
  const streamEnd = Number(audio.duration ?? media.format?.duration);
  const declaredEnd = Number(clip.time?.[1] ?? streamEnd);
  const end = Number.isFinite(streamEnd) && streamEnd > 0 ? Math.min(streamEnd, declaredEnd) : declaredEnd;
  const speed = clip.speed ?? 1;
  const duration = (end - start) / speed;
  if (!(Number.isFinite(duration) && start >= 0 && duration >= 1)) {
    return reject('LOUDNESS_UNMEASURABLE', '可用音频不足 1 秒，无法可靠测量响度');
  }

  const filters = atempoChain(speed).factors.filter((factor) => factor !== 1).map((factor) => `atempo=${factor}`);
  filters.push('aformat=sample_rates=48000:channel_layouts=stereo');
  // Video fades affect its picture in the preview, while audio clips have a volume envelope.
  if (clip.kind === 'sound') {
    const [fadeIn, fadeOut] = effectiveFade(clip).map((value) => Math.min(value, duration));
    if (fadeIn) filters.push(`afade=t=in:d=${fadeIn.toFixed(6)}`);
    if (fadeOut) filters.push(`afade=t=out:st=${(duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`);
  }
  const standard = LOUDNESS_PRESETS[preset];
  filters.push(`loudnorm=I=${standard.I}:TP=${standard.TP}:LRA=${standard.LRA}:print_format=json`);
  let measured;
  try {
    const result = await run(binary.path, [
      '-hide_banner', '-nostdin', '-loglevel', 'info', ...MEDIA_INPUT, '-ss', start.toFixed(6), '-t', (end - start).toFixed(6),
      '-i', file, '-vn', '-sn', '-dn', '-af', filters.join(','), '-f', 'null', '-',
    ], options);
    measured = parseLoudnormJson(result.stderr);
  } catch {
    return signal.aborted ? reject('CANCELLED', '响度测量已取消或超时', 408)
      : reject('AUDIO_DECODE_FAILED', 'FFmpeg 无法测量所选音频片段');
  }
  const inputLufs = Number(measured.input_i);
  const inputPeakDbtp = Number(measured.input_tp);
  if (!(Number.isFinite(inputLufs) && inputLufs > UNMEASURABLE_LUFS && Number.isFinite(inputPeakDbtp))) {
    return reject('LOUDNESS_UNMEASURABLE', '所选区间接近静音，无法可靠测量响度');
  }

  const desiredDb = standard.I - inputLufs;
  const peakDb = standard.TP - TP_HEADROOM_DB - inputPeakDbtp;
  const maxDb = 20 * Math.log10(VOLUME_MAX);
  const wantedVolume = dbToVolume(Math.min(desiredDb, peakDb, maxDb));
  // Avoid rounding a peak-limited gain above the ceiling.
  const volume = clampVolume(Math.floor(wantedVolume * 1_000 + 1e-8) / 1_000);
  if (volume === 0) return reject('LOUDNESS_UNMEASURABLE', '所需音量低于编辑器可保存的精度');
  const gainDb = 20 * Math.log10(volume);
  const limitedBy = desiredDb <= Math.min(peakDb, maxDb) ? null : peakDb <= maxDb ? 'peak' : 'volume';
  return {
    ok: /** @type {const} */ (true),
    ops: [{ op: 'props', edits: [{ clip: clipId, prop: 'volume', value: volume }] }],
    loudness: {
      preset, inputLufs, inputPeakDbtp, targetLufs: standard.I,
      appliedGainDb: roundDb(gainDb), estimatedLufs: roundDb(inputLufs + gainDb),
      estimatedPeakDbtp: roundDb(inputPeakDbtp + gainDb), volume, limitedBy,
    },
  };
}
