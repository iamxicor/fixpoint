import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export interface SideBySideOptions {
  left: string;
  right: string;
  out: string;
  leftLabel: string;
  rightLabel: string;
  caption?: string;
  height?: number;
}

/** Two simulator recordings side by side with burned-in labels (H.264, yuv420p). */
export async function composeSideBySide(o: SideBySideOptions): Promise<string> {
  if (!ffmpegAvailable()) throw new Error('ffmpeg not found (brew install ffmpeg)');
  if (!existsSync(o.left) || !existsSync(o.right)) throw new Error('input recordings missing');
  const h = o.height ?? 1200;
  const label = (text: string) => `drawtext=text='${esc(text)}':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=24`;
  const caption = o.caption ? `,drawtext=text='${esc(o.caption)}':fontsize=30:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10:x=(w-text_w)/2:y=h-th-24` : '';
  const filter = `[0:v]scale=-2:${h},${label(o.leftLabel)}[l];[1:v]scale=-2:${h},${label(o.rightLabel)}[r];[l][r]hstack=inputs=2${caption}[v]`;
  execFileSync('ffmpeg', ['-y', '-i', o.left, '-i', o.right, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
  return o.out;
}

/** Downscaled GIF for READMEs (palette-based). */
export function toGif(input: string, out: string, opts: { width?: number; fps?: number } = {}): string {
  if (!ffmpegAvailable()) throw new Error('ffmpeg not found');
  const w = opts.width ?? 800;
  const fps = opts.fps ?? 12;
  execFileSync('ffmpeg', ['-y', '-i', input, '-filter_complex', `[0:v]fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`, out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
  return out;
}

/** Burns a sequence of timed captions into a video: [{at, duration, text}]. */
export function burnCaptions(input: string, out: string, captions: { at: number; duration: number; text: string }[], opts: { fontsize?: number } = {}): string {
  if (!ffmpegAvailable()) throw new Error('ffmpeg not found');
  const parts = captions.map((c) => `drawtext=text='${esc(c.text)}':fontsize=${opts.fontsize ?? 34}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=14:x=(w-text_w)/2:y=h-th-40:enable='between(t,${c.at},${c.at + c.duration})'`);
  execFileSync('ffmpeg', ['-y', '-i', input, '-vf', parts.join(','), '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
  return out;
}
