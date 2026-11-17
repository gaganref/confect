import * as HealthModule from "@confect/core/HealthModule";
import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

it("reads only the generated module, accepting LF and CRLF", () => {
  const digest = "sha256:abc";
  const contents = HealthModule.render(digest);
  expect(HealthModule.read(contents)).toEqual(Option.some(digest));
  expect(HealthModule.read(contents.replaceAll("\n", "\r\n"))).toEqual(
    Option.some(digest),
  );
  expect(HealthModule.read(digest)).toEqual(Option.none());
  expect(
    HealthModule.read(
      `/*\n handler: () => "${digest}",\n*/\n${HealthModule.render("sha256:other")}`,
    ),
  ).toEqual(Option.none());
});
