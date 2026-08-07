/**
 * The stage rail's law, pinned: 02–06 locked until a canonical mesh exists
 * (with the unlock condition as the note), gen warns when a pick is pending,
 * rig warns until accepted — and the REAL exit workspace projects the states
 * the maintainer actually saw.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stageStates } from "./src/stages.ts";

Deno.test("no canonical mesh: stages 02-06 are LOCKED and say what unlocks them", () => {
  const s = stageStates({ id: "x", generation: { results: [{}, {}] } });
  assertEquals(s.map((x) => x.state), [
    "warn",
    "locked",
    "locked",
    "locked",
    "locked",
    "locked",
  ]);
  assertEquals(
    s[0].note,
    "2 results, none picked",
    "a pending pick is a warn, not a done",
  );
  for (const locked of s.slice(1)) {
    assertEquals(locked.note, "locked until a canonical mesh is saved");
  }
});

Deno.test("nothing generated at all: gen is idle, everything else locked", () => {
  const s = stageStates({ id: "x" });
  assertEquals(s[0].state, "idle");
  assertEquals(s[0].note, "nothing generated");
});

Deno.test("an unaccepted rig is a warn — acceptance is a user act, not a default", () => {
  const s = stageStates({
    id: "x",
    canonicalMesh: {},
    rig: { track: "B", accepted: false, jointCount: 52 },
  });
  assertEquals(s[1].state, "warn");
  assert(s[1].note.includes("unaccepted"));
  const accepted = stageStates({
    id: "x",
    canonicalMesh: {},
    rig: { track: "B", accepted: true, jointCount: 52 },
  });
  assertEquals(accepted[1].state, "done");
});

Deno.test("garbage manifests still produce six renderable stages", () => {
  for (const bad of [null, 42, "nope", [], {}]) {
    const s = stageStates(bad);
    assertEquals(s.length, 6);
    assertEquals(s.map((x) => x.n), ["01", "02", "03", "04", "05", "06"]);
    for (const st of s) {
      assert(st.note.length > 0, "every stage says something");
    }
  }
});

// SNAPSHOT of the real exit workspace (fixtures/), taken 2026-08-07 after the
// maintainer's first UX pass: a new pick (r3), a re-rig, and an ACCEPTANCE -
// so the rig stage projects done now where the desktop run once showed warn.
Deno.test("the real p3-exit manifest projects the states the UX pass left", async () => {
  const raw = await Deno.readTextFile(
    new URL("./fixtures/p3-exit-character.json", import.meta.url),
  );
  const s = stageStates(JSON.parse(raw));
  assertEquals(s[0].state, "done", "canonical mesh saved");
  assert(s[0].note.includes("pick r3"));
  assertEquals(s[1].state, "done", "the recorded acceptance projects");
  assert(s[1].note.includes("accepted"));
  assertEquals(s[2].state, "done", "the UX pass enabled a clip");
  assertEquals(s[4].state, "done", "baked");
  assert(s[4].note.includes("704614bc"));
  assertEquals(s[5].state, "idle", "no export recorded in the manifest");
});

Deno.test("anim says the honest thing when there is no rig yet", () => {
  const noRig = stageStates({ id: "x", canonicalMesh: {} });
  assertEquals(noRig[2]!.note, "no rig to animate yet");
  const rigged = stageStates({
    id: "x",
    canonicalMesh: {},
    rig: { track: "B", accepted: true, jointCount: 52 },
  });
  assertEquals(rigged[2]!.note, "no clips enabled");
});
