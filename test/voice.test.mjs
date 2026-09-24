import { test } from "node:test";
import assert from "node:assert/strict";
import { patientAgreed, medicationBreach, TOOL_DECLARATIONS, SERVER_TOOLS, voiceInstruction } from "../lib/voice.ts";
import { emergencyAnswer, redFlag, EMERGENCY_LINE, OUT_OF_SCOPE_REPLY } from "../lib/chat.ts";

test("consent is read from the patient's own words, and hesitation wins", () => {
  for (const yes of ["Yes please", "yeah go ahead", "okay, book it", "haan, theek hai", "Correct, confirm it"])
    assert.ok(patientAgreed(yes), `should count as yes: ${yes}`);
  for (const no of [
    "",
    "how much is it?",
    "no",
    "yes but wait, change the time",
    "hold on",
    "can you do a different day",
    "not yet",
  ])
    assert.equal(patientAgreed(no), false, `should not count as yes: ${no}`);
});

test("spoken medication is caught unless the server said it first", () => {
  assert.equal(medicationBreach("You could take paracetamol for now.", ""), "paracetamol");
  assert.equal(medicationBreach("Try 500 mg twice a day.", ""), "500 mg");
  assert.equal(medicationBreach("The doctor will decide what you need.", ""), null);
  // A prep note from the catalogue may be relayed word for word.
  const grounded = JSON.stringify({ preparation: "Avoid the inhaler for 6 hours if advised." });
  assert.equal(medicationBreach("You should avoid the inhaler for six hours beforehand.", grounded), null);
  assert.equal(medicationBreach("Use the inhaler and take ibuprofen.", grounded), "ibuprofen");
});

test("the tool contract is closed: no generic query, every server tool declared", () => {
  const names = TOOL_DECLARATIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tools");
  for (const s of SERVER_TOOLS) assert.ok(names.includes(s), `${s} is declared`);
  assert.ok(!names.some((n) => /sql|query|db|insert/i.test(n)));
  // confirm takes a short pending id — the signed token never passes through the model.
  const confirm = TOOL_DECLARATIONS.find((t) => t.name === "confirm_booking");
  assert.deepEqual(Object.keys(confirm.parameters.properties), ["pendingId"]);
});

test("the voice instruction carries the fixed numbers and the booking rule", () => {
  const text = voiceInstruction();
  assert.ok(text.includes(EMERGENCY_LINE));
  assert.ok(text.includes("+91 80 4000 1200"));
  assert.match(text, /Never say something is booked unless confirm_booking returned ok/);
});

test("voice and text share one deterministic emergency answer", () => {
  const why = redFlag("my father's face is drooping and his speech is slurred speech");
  assert.ok(why);
  const e = emergencyAnswer(why);
  assert.equal(e.urgency, "emergency");
  assert.deepEqual(e.emergency, { why, line: EMERGENCY_LINE });
  assert.ok(e.reply.includes(EMERGENCY_LINE));
  assert.deepEqual([e.doctors, e.tests], [[], []]);
  assert.ok(OUT_OF_SCOPE_REPLY.includes("+91 80 4000 1200"));
});

test("stray transcribed noise is recognised, real short answers are not", async () => {
  const { soundsLikeNoise, askedForName } = await import("../lib/voice.ts");
  for (const noise of ["c'est", "Chantilly", "", "  ", "...", "hmm", "la la", "¿qué?"])
    assert.ok(soundsLikeNoise(noise), `should be noise: "${noise}"`);
  for (const answer of [
    "yes", "No", "about a week", "2 days", "since Monday", "gradually", "Suddenly",
    "evenings", "nausea", "none", "my knee", "haan", "fever too", "the first one", "98765 43210",
    "It started when I was at work",
  ])
    assert.equal(soundsLikeNoise(answer), false, `should be an answer: "${answer}"`);
  assert.ok(askedForName("Could I have the patient's full name, please?"));
  assert.equal(askedForName("How long have you had the headache?"), false);
});

test("appended disclaimers are cut, the recommendation is kept", async () => {
  const { stripDisclaimer } = await import("../lib/voice.ts");
  const said =
    "This could be indigestion. I'd recommend seeing Dr. Rohit Nambiar in Gastroenterology this week. Shall we look at slots? This information is not medical advice or diagnosis. Please see a healthcare professional or seek care.";
  const r = stripDisclaimer(said);
  assert.ok(r.found);
  assert.ok(r.text.includes("Dr. Rohit Nambiar"));
  assert.ok(r.text.includes("Shall we look at slots?"));
  assert.ok(!/medical advice/i.test(r.text));
  assert.ok(!/healthcare professional/i.test(r.text), r.text);
  assert.equal(stripDisclaimer("I'd recommend seeing a neurologist this week.").found, false);
});
