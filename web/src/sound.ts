/**
 * Move sounds, synthesised rather than sampled.
 *
 * An exported snapshot is one file that has to work with no network, and a set of
 * mp3s would be a few hundred kilobytes of it. These are a few lines of oscillator
 * and noise instead: a wooden knock for a move, a harder and brighter one for a
 * capture, a short double blip for check.
 */

const STORAGE_KEY = 'chesscoach.sound';

export type { MoveSound } from './format';
import type { MoveSound } from './format';

let context: AudioContext | null = null;
let enabled = readPreference();

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private windows and blocked storage both throw; sound on is the better default.
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    // The preference is a convenience; losing it is not worth an error.
  }
}

/** Browsers refuse to start audio before a gesture, so the context is made on the
 *  first sound — which by definition follows a click or a key press. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === 'suspended') void context.resume();
  return context;
}

/** A short burst of filtered noise — the click of wood on wood. */
function knock(ctx: AudioContext, at: number, gain: number, frequency: number, decay: number): void {
  const frames = Math.floor(ctx.sampleRate * decay);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // Noise shaped by an exponential fall, which is what stops it sounding like static.
    data[i] = (Math.random() * 2 - 1) * Math.exp((-6 * i) / frames);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = 0.9;

  const amp = ctx.createGain();
  amp.gain.value = gain;

  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(at);
  source.stop(at + decay);
}

/** The body under the knock: a low sine that dies almost immediately. */
function thump(ctx: AudioContext, at: number, frequency: number, gain: number, decay: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, at);
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.6, at + decay);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + decay);

  osc.connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + decay);
}

function blip(ctx: AudioContext, at: number, frequency: number, gain: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = frequency;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);

  osc.connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.12);
}

export function playMoveSound(kind: MoveSound): void {
  if (!enabled) return;
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  if (kind === 'capture') {
    // Harder and brighter: a capture should be audibly a heavier event than a move.
    knock(ctx, now, 0.5, 2600, 0.085);
    thump(ctx, now, 150, 0.35, 0.1);
    return;
  }
  if (kind === 'check') {
    blip(ctx, now, 880, 0.16);
    blip(ctx, now + 0.09, 1320, 0.14);
    return;
  }
  knock(ctx, now, 0.32, 1750, 0.055);
  thump(ctx, now, 195, 0.24, 0.07);
}
