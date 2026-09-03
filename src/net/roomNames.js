/**
 * Dance-room names: short, kid-friendly, easy to say out loud across a
 * living room ("join funky-otter!"). Typed names are normalized the same
 * way on client and server so "Funky Otter" and "funky-otter" meet.
 */

const ADJECTIVES = [
  'funky', 'groovy', 'jazzy', 'bouncy', 'shiny', 'wiggly', 'zippy', 'happy',
  'disco', 'neon', 'cosmic', 'sparkly', 'mellow', 'wild', 'sunny', 'electric',
];
const ANIMALS = [
  'otter', 'panda', 'llama', 'tiger', 'koala', 'penguin', 'fox', 'dolphin',
  'flamingo', 'rabbit', 'moose', 'gecko', 'parrot', 'walrus', 'yak', 'zebra',
];

export function randomRoomName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

export const MAX_ROOM_NAME = 24;

/** Lowercase, spaces → dashes, only [a-z0-9-], trimmed to MAX_ROOM_NAME. */
export function normalizeRoomName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_ROOM_NAME);
}
