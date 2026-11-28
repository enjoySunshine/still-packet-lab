import assert from "assert";

import { schema, t, Decoder, type SchemaType } from "@colyseus/schema";
import { Protocol } from "@colyseus/core";
import { fakeClient, serializerFor } from "./utils/index.ts";

//
// The opening packet is a thing a client already holds: the full state handed
// over when it joined. Encoding a later snapshot (the score went 16 → 73) must
// not reach back into those bytes. The opening packet keeps decoding to 午 = 16
// however many times it is replayed, and whether the room later sends a fresh
// full snapshot or a delta on top of the opening one.
//

const Entry = schema({
  name: t.string(),
  score: t.uint16(),
  // padding, so the opening packet is 15 bytes and the score delta 4 — the
  // sizes reported in the field, which cannot be told apart from the length.
  a: t.uint8(),
  b: t.uint8(),
  c: t.uint8(),
});
type Entry = SchemaType<typeof Entry>;

/** 午 = 16, with the same number of trailing fields the real state has. */
function openingState() {
  const state = new Entry();
  state.name = "午";
  state.score = 16;
  state.a = 1; state.b = 1; state.c = 1;
  return state;
}

/** Decode a full state / patch frame (one protocol byte) into plain JSON. */
function decode(frame: Uint8Array) {
  const state = new Entry();
  new Decoder(state).decode(frame.subarray(1));
  return state.toJSON();
}

/** What a client ends up with after decoding `frames` in order. */
function replay(frames: Uint8Array[]) {
  const state = new Entry();
  const decoder = new Decoder(state);
  for (const frame of frames) { decoder.decode(frame.subarray(1)); }
  return state.toJSON();
}

describe("the opening packet stays the opening packet", () => {

  it("is 15 bytes and carries 午 = 16", () => {
    const serializer = serializerFor(openingState());
    serializer.applyPatches([]); // until a tick drains them, setup changes force a re-encode

    const opening = serializer.getFullState(fakeClient(false));
    assert.strictEqual(opening[0], Protocol.ROOM_STATE);
    assert.strictEqual(opening.byteLength, 15);
    assert.deepStrictEqual(decode(opening), { name: "午", score: 16, a: 1, b: 1, c: 1 });
  });

  it("keeps its bytes when a later snapshot carries 73", () => {
    const state = openingState();
    const serializer = serializerFor(state);
    serializer.applyPatches([]);

    const opening = serializer.getFullState(fakeClient(false));
    const held = Uint8Array.from(opening);

    state.score = 73;
    const later = serializer.getFullState(fakeClient(false));

    assert.notStrictEqual(later, opening, "the later snapshot is a packet of its own");
    assert.deepStrictEqual([...opening], [...held], "the opening packet's bytes are unchanged");
    assert.deepStrictEqual(decode(opening), { name: "午", score: 16, a: 1, b: 1, c: 1 },
      "the held opening packet still decodes to 16");
    assert.deepStrictEqual(decode(later), { name: "午", score: 73, a: 1, b: 1, c: 1 },
      "the later snapshot carries the new score");
  });

  it("a 4-byte delta takes 16 to 73, and leaves the opening packet at 16", () => {
    const state = openingState();
    const serializer = serializerFor(state);
    serializer.applyPatches([]);

    // what the first client was handed, and still holds
    const first = fakeClient(false);
    first.raw(serializer.getFullState(first));
    const opening = first.reliable[0];
    assert.strictEqual(opening.byteLength, 15);

    // the room's score changes; whoever is still listening gets a delta
    state.score = 73;
    const live = fakeClient(false);
    serializer.applyPatches([live]);
    const delta = live.reliable[0];
    assert.strictEqual(delta[0], Protocol.ROOM_STATE_PATCH);
    assert.strictEqual(delta.byteLength, 4);
    assert.deepStrictEqual(replay([opening, delta]), { name: "午", score: 73, a: 1, b: 1, c: 1 },
      "16 plus the delta is 73");

    // a client joining now gets a fresh snapshot instead
    const late = fakeClient(false);
    late.raw(serializer.getFullState(late));
    assert.strictEqual(decode(late.reliable[0]).score, 73);

    // the first client replays only what it was given
    assert.deepStrictEqual(decode(opening), { name: "午", score: 16, a: 1, b: 1, c: 1 },
      "the delta and the later snapshot must not rewrite the opening packet");
    assert.deepStrictEqual(replay([opening]), { name: "午", score: 16, a: 1, b: 1, c: 1 });
  });

  it("keeps 午 (never an empty roster) and its first bytes across encodes", () => {
    const state = openingState();
    const serializer = serializerFor(state);
    serializer.applyPatches([]);

    const opening = serializer.getFullState(fakeClient(false));
    const held = Uint8Array.from(opening);

    state.score = 73;
    serializer.applyPatches([fakeClient(false)]); // a patch reuses the encoder buffer
    serializer.getFullState(fakeClient(false));   // and so does a second full encode

    assert.deepStrictEqual([...opening], [...held]);
    assert.deepStrictEqual(decode(opening), { name: "午", score: 16, a: 1, b: 1, c: 1 },
      "午 is still there, at 16 — never emptied");
  });

  it("two clients that joined at different times see 16 and 73, respectively", () => {
    const state = openingState();
    const serializer = serializerFor(state);
    serializer.applyPatches([]);

    const early = fakeClient(false);
    early.raw(serializer.getFullState(early));

    state.score = 73;

    const late = fakeClient(false);
    late.raw(serializer.getFullState(late));

    assert.deepStrictEqual(decode(early.reliable[0]), { name: "午", score: 16, a: 1, b: 1, c: 1 },
      "the screen that joined first is still at 16");
    assert.deepStrictEqual(decode(late.reliable[0]), { name: "午", score: 73, a: 1, b: 1, c: 1 },
      "the screen that joined later is at 73");
  });
});
