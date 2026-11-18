import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { shapes } from "./differentialShapes";

// The seeded differential's host functions: `shapeNN` takes shape NN as its
// arguments, and `echoNN` returns the value it is given under shape NN as its
// declared return.

const host = (index: number) =>
  mutationGeneric({
    args: shapes[index]!,
    handler: () => Promise.resolve(null),
  });

const echo = (index: number) =>
  mutationGeneric({
    args: { value: v.any() },
    returns: shapes[index]!,
    handler: (_ctx, { value }) => Promise.resolve(value as never),
  });

export const shape00 = host(0);
export const echo00 = echo(0);
export const shape01 = host(1);
export const echo01 = echo(1);
export const shape02 = host(2);
export const echo02 = echo(2);
export const shape03 = host(3);
export const echo03 = echo(3);
export const shape04 = host(4);
export const echo04 = echo(4);
export const shape05 = host(5);
export const echo05 = echo(5);
export const shape06 = host(6);
export const echo06 = echo(6);
export const shape07 = host(7);
export const echo07 = echo(7);
export const shape08 = host(8);
export const echo08 = echo(8);
export const shape09 = host(9);
export const echo09 = echo(9);
export const shape10 = host(10);
export const echo10 = echo(10);
export const shape11 = host(11);
export const echo11 = echo(11);
export const shape12 = host(12);
export const echo12 = echo(12);
export const shape13 = host(13);
export const echo13 = echo(13);
export const shape14 = host(14);
export const echo14 = echo(14);
export const shape15 = host(15);
export const echo15 = echo(15);
export const shape16 = host(16);
export const echo16 = echo(16);
export const shape17 = host(17);
export const echo17 = echo(17);
export const shape18 = host(18);
export const echo18 = echo(18);
export const shape19 = host(19);
export const echo19 = echo(19);
export const shape20 = host(20);
export const echo20 = echo(20);
export const shape21 = host(21);
export const echo21 = echo(21);
export const shape22 = host(22);
export const echo22 = echo(22);
export const shape23 = host(23);
export const echo23 = echo(23);
export const shape24 = host(24);
export const echo24 = echo(24);
export const shape25 = host(25);
export const echo25 = echo(25);
export const shape26 = host(26);
export const echo26 = echo(26);
export const shape27 = host(27);
export const echo27 = echo(27);
export const shape28 = host(28);
export const echo28 = echo(28);
export const shape29 = host(29);
export const echo29 = echo(29);
export const shape30 = host(30);
export const echo30 = echo(30);
export const shape31 = host(31);
export const echo31 = echo(31);
export const shape32 = host(32);
export const echo32 = echo(32);
export const shape33 = host(33);
export const echo33 = echo(33);
export const shape34 = host(34);
export const echo34 = echo(34);
export const shape35 = host(35);
export const echo35 = echo(35);
export const shape36 = host(36);
export const echo36 = echo(36);
export const shape37 = host(37);
export const echo37 = echo(37);
export const shape38 = host(38);
export const echo38 = echo(38);
export const shape39 = host(39);
export const echo39 = echo(39);
