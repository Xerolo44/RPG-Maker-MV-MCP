import assert from "node:assert/strict";
import test from "node:test";
import { cmd, terminated, validateCommandList } from "../dist/commandList.js";

const END = cmd(0, 0);

test("cmd builds a command with rest parameters", () => {
  assert.deepEqual(cmd(401, 2, "hi"), { code: 401, indent: 2, parameters: ["hi"] });
});

test("terminated appends a terminator only when missing", () => {
  const list = [cmd(401, 0, "hi")];
  assert.deepEqual(terminated(list), [...list, END]);
  assert.equal(terminated([...list, END]).length, 2);
  assert.deepEqual(terminated([]), [END]);
});

test("accepts a terminated flat list", () => {
  assert.deepEqual(validateCommandList([cmd(101, 0, "", 0, 0, 2), cmd(401, 0, "hi"), END]), []);
});

test("reports a missing terminator", () => {
  const problems = validateCommandList([cmd(101, 0), cmd(401, 0, "hi")]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 1/);
  assert.match(problems[0], /terminator/);
});

test("reports Show Choices (102) without End Choices (404)", () => {
  const list = [cmd(101, 0), cmd(401, 0, "a"), cmd(401, 0, "b"), cmd(102, 0, ["x"], 0), cmd(402, 0, 0, "x"), cmd(0, 1), END];
  const problems = validateCommandList(list);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 3/);
  assert.match(problems[0], /102/);
  assert.match(problems[0], /404/);
});

test("reports Conditional Branch (111) without Branch End (412)", () => {
  const problems = validateCommandList([cmd(111, 0, 0, 1, 0), cmd(0, 1), END]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 0/);
  assert.match(problems[0], /111/);
  assert.match(problems[0], /412/);
});

test("reports Loop (112) without Repeat Above (413)", () => {
  const problems = validateCommandList([cmd(101, 0), cmd(112, 0), cmd(0, 1), END]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 1/);
  assert.match(problems[0], /112/);
  assert.match(problems[0], /413/);
});

test("reports an indent jump greater than one", () => {
  const problems = validateCommandList([cmd(101, 0), cmd(401, 2, "hi"), END]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 1/);
  assert.match(problems[0], /401/);
});

test("accepts a conditional nested inside a choice branch", () => {
  const list = [
    cmd(102, 0, ["a", "b"], 0),
    cmd(402, 0, 0, "a"),
    cmd(111, 1, 0, 1, 0),
    cmd(401, 2, "x"),
    cmd(411, 1),
    cmd(0, 2),
    cmd(412, 1),
    cmd(402, 0, 1, "b"),
    cmd(0, 1),
    cmd(404, 0),
    END,
  ];
  assert.deepEqual(validateCommandList(list), []);
});

test("reports a sibling or closer with no matching opener", () => {
  const problems = validateCommandList([cmd(412, 0), cmd(402, 0, 0, "x"), END]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /index 0/);
  assert.match(problems[1], /index 1/);
});

test("reports an inner block left open when the outer sibling arrives", () => {
  const list = [cmd(102, 0, ["a"], 0), cmd(402, 0, 0, "a"), cmd(111, 1, 0, 1, 0), cmd(0, 2), cmd(404, 0), END];
  const problems = validateCommandList(list);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index 2/);
  assert.match(problems[0], /111/);
});
