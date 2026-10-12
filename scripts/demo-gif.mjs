#!/usr/bin/env node
/**
 * Renders docs/assets/demo.gif from scripts/demo.mjs's transcript — the GIF's
 * single source of truth (one run produces both). Dev-only tooling: requires
 * ImageMagick (`convert`) and ffmpeg on PATH; the committed GIF is the
 * artifact and CI never runs this script.
 *
 * Frames: progressive reveal with a scrolling viewport (the transcript is
 * longer than one screen); `%` is escaped for ImageMagick's annotate.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs/assets/demo.gif');
/** System mono font; override with DEMO_GIF_FONT on distros that ship it elsewhere. */
const FONT = process.env.DEMO_GIF_FONT ?? '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const WIDTH = 1200;
const VISIBLE = 29;
const LEFT = 26;
const TOP = 46;
const LINE = 21;
const SIZE = 15;
const REVEAL = 3;
const HOLD = 3;
const BOTTOM_PAD = 24;
const PALETTE_COLORS = 128;

const COLORS = { prompt: '#7ee787', log: '#79c0ff', error: '#ff7b72', text: '#c9d1d9' };

function transcript() {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/demo.mjs')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(run.status ?? 1);
  }
  return run.stdout.replace(/\n$/, '').split('\n');
}

function colorFor(line) {
  if (line.startsWith('$')) return COLORS.prompt;
  if (line.includes('[log]')) return COLORS.log;
  if (/error|isError/.test(line)) return COLORS.error;
  return COLORS.text;
}

function renderFrame(lines, outPath) {
  const height = TOP + VISIBLE * LINE + BOTTOM_PAD;
  const args = [
    '-size',
    `${WIDTH}x${height}`,
    'xc:#0d1117',
    '-font',
    FONT,
    '-pointsize',
    String(SIZE),
  ];
  lines.forEach((line, index) => {
    const escaped = line.replaceAll('%', '%%');
    args.push('-fill', colorFor(line), '-annotate', `+${LEFT}+${TOP + index * LINE}`, escaped);
  });
  args.push(outPath);
  const convert = spawnSync('convert', args, { encoding: 'utf8' });
  if (convert.status !== 0) {
    process.stderr.write(convert.stderr);
    process.exit(1);
  }
}

/** Progressive reveal over a scrolling viewport of the transcript. */
function revealFrames(lines) {
  const frames = [];
  for (let end = REVEAL; end <= lines.length; end += REVEAL) {
    frames.push(lines.slice(Math.max(0, end - VISIBLE), end));
  }
  if (frames.at(-1)?.at(-1) !== lines.at(-1)) {
    frames.push(lines.slice(Math.max(0, lines.length - VISIBLE)));
  }
  return frames;
}

function assemble(framesDir) {
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      '1',
      '-start_number',
      '1',
      '-i',
      join(framesDir, 'frame-%03d.png'),
      '-filter_complex',
      `split[s0][s1];[s0]palettegen=max_colors=${PALETTE_COLORS}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop',
      '0',
      OUT,
    ],
    { encoding: 'utf8' },
  );
  if (ffmpeg.status !== 0) {
    process.stderr.write(ffmpeg.stderr);
    process.exit(1);
  }
}

const lines = transcript();
const frames = revealFrames(lines);
const dir = mkdtempSync(join(tmpdir(), 'demo-gif-'));
frames.forEach((frameLines, index) => {
  renderFrame(frameLines, join(dir, `frame-${String(index + 1).padStart(3, '0')}.png`));
});
const lastFrame = join(dir, `frame-${String(frames.length).padStart(3, '0')}.png`);
for (let extra = 1; extra <= HOLD; extra++) {
  copyFileSync(lastFrame, join(dir, `frame-${String(frames.length + extra).padStart(3, '0')}.png`));
}
mkdirSync(join(ROOT, 'docs/assets'), { recursive: true });
assemble(dir);
rmSync(dir, { recursive: true, force: true });
const size = statSync(OUT).size;
console.log(
  `demo.gif: ${frames.length + HOLD} frames, ${(size / 1024 / 1024).toFixed(2)} MB -> ${OUT}`,
);
