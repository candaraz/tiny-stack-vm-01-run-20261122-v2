// A tiny stack VM for make.fun's tiny-stack-vm-01 ISA. Runs every
// program of a set (/input/<id>/program.bin + input.bin) and writes
// /output/<id>/stdout.bin and exit.txt. Node 22, no deps. 32-bit wrapping
// values, 256-value stack, 64-entry call stack, 256 words of memory,
// 1,000,000-step and 65,536-byte limits, traps 2-11. A trap keeps the
// output written before it.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [immediate bytes, pops, pushes] per opcode byte; anything else is
// an unknown opcode (trap 5).
const T = new Array(256);
for (const [o, i, p, q] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
]) T[o] = [i, p, q];

const enc = new TextEncoder();

// Runs one program on one input. Returns [stdout bytes, exit code].
function runVM(prog, input) {
  const S = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const n = prog.length;
  const done = (exit) => [out.subarray(0, ol), exit];
  for (;;) {
    if (steps === 1000000) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const op = prog[pc];
    const e = T[op];
    if (!e) return done(5); // unknown opcode
    if (pc + e[0] >= n) return done(9); // immediate cut off by the end
    steps++;
    const nx = pc + 1 + e[0];
    if (sp < e[1]) return done(2); // stack underflow
    if (sp - e[1] + e[2] > 256) return done(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: S[sp++] = (prog[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian
        S[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24);
        break;
      case 0x03: sp--; break;
      case 0x04: S[sp] = S[sp - 1]; sp++; break;
      case 0x05: { const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t; break; } // SWAP
      case 0x06: S[sp] = S[sp - 2]; sp++; break;
      case 0x07: { const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; } // ROT
      case 0x17: S[sp - 1] = (-S[sp - 1]) | 0; break;
      case 0x1b: S[sp - 1] = ~S[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let go = op === 0x30;
        if (op !== 0x30) { const v = S[--sp]; go = op === 0x31 ? v === 0 : v !== 0; }
        if (go) pc = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return done(7);
        C[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = S[sp - 1];
        if (a < 0 || a > 255) return done(6);
        S[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE (v addr --)
        const a = S[sp - 1], v = S[sp - 2];
        if (a < 0 || a > 255) return done(6);
        sp -= 2;
        M[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        const b = enc.encode(String(S[sp - 1]));
        if (ol + b.length > 65536) return done(11);
        sp--;
        out.set(b, ol);
        ol += b.length;
        break;
      }
      case 0x51: // PUTC: one byte, low 8 bits
        if (ol + 1 > 65536) return done(11);
        out[ol++] = S[--sp] & 255;
        break;
      case 0x52: S[sp++] = ip < input.length ? input[ip++] : -1; break;
      case 0x53: return done(S[--sp] & 255); // EXIT: low byte
      default: { // two-operand arithmetic / logic / comparison
        const b = S[sp - 1], a = S[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13:
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        }
        sp -= 2;
        S[sp++] = r;
      }
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const prog = readFileSync(join(IN, id, 'program.bin'));
  const input = readFileSync(join(IN, id, 'input.bin'));
  const [stdout, exit] = runVM(prog, input);
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), stdout);
  writeFileSync(join(OUT, id, 'exit.txt'), String(exit) + '\n');
}
