import { describe, expect, test } from "bun:test";
import { reactDoctorArgs, resolveReactDoctorBase } from "../../scripts/react-doctor";

describe("React Doctor runner", () => {
  test("uses the current commit as the local comparison base", () => {
    const base = resolveReactDoctorBase({});
    const args = reactDoctorArgs({}, base);

    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(args).toContain("lines");
    expect(args.slice(-2)).toEqual(["--base", base]);
  });

  test("uses the previous commit as the CI comparison base", () => {
    const base = resolveReactDoctorBase({ CI: "true" });
    const args = reactDoctorArgs({ CI: "true" }, base);

    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(args.slice(-2)).toEqual(["--base", base]);
  });

  test("honors an explicit CI comparison base", () => {
    const args = reactDoctorArgs({ CI: "true", REACT_DOCTOR_BASE: "origin/main" });

    expect(args.slice(-2)).toEqual(["--base", "origin/main"]);
  });

  test("honors an explicit base that exists in the repository", () => {
    const head = resolveReactDoctorBase({});

    expect(resolveReactDoctorBase({ CI: "true", REACT_DOCTOR_BASE: head })).toBe(head);
  });

  test("falls back to the previous commit when the explicit base no longer exists", () => {
    const missingBase = "0123456789abcdef0123456789abcdef01234567";
    const fallback = resolveReactDoctorBase({ CI: "true" });

    expect(resolveReactDoctorBase({ CI: "true", REACT_DOCTOR_BASE: missingBase })).toBe(fallback);
  });
});
