import { test } from "node:test";
import assert from "node:assert/strict";
import { newSession, sessionValid, passwordMatches, safeNext, SESSION_MS } from "../lib/auth.ts";

test("a session lasts exactly seven minutes, then is refused", () => {
  const s = newSession(1_000_000_000_000, "pw");
  assert.equal(s.expires - 1_000_000_000_000, SESSION_MS);
  assert.equal(SESSION_MS, 7 * 60_000);
  assert.ok(sessionValid(s.value, 1_000_000_000_000 + SESSION_MS - 1, "pw"));
  assert.equal(sessionValid(s.value, 1_000_000_000_000 + SESSION_MS, "pw"), false);
});

test("a session cannot be forged, extended, or carried across a password change", () => {
  const now = 1_000_000_000_000;
  const s = newSession(now, "pw");
  const [, sig] = s.value.split(".");
  assert.equal(sessionValid(`${now + 60 * 60_000}.${sig}`, now, "pw"), false, "extended expiry");
  assert.equal(sessionValid(s.value, now, "new-password"), false, "password rotated");
  for (const junk of [undefined, "", "abc", `${now + 1000}.`, "1.2.3"]) assert.equal(sessionValid(junk, now, "pw"), false);
  assert.equal(newSession(now, null), null, "no password, no session");
});

test("password check is exact", () => {
  assert.ok(passwordMatches("s3cret", "s3cret"));
  for (const wrong of ["", "s3cre", "s3cret ", "S3CRET"]) assert.equal(passwordMatches(wrong, "s3cret"), false);
  assert.equal(passwordMatches("anything", null), false);
});

test("sign-in only ever redirects within the site", () => {
  assert.equal(safeNext("/doctors?specialty=ENT"), "/doctors?specialty=ENT");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", undefined, 42]) assert.equal(safeNext(bad), "/");
});
