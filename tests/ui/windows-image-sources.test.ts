import { describe, expect, test } from "bun:test";
import {
  imageAltFromPath,
  imageSourceFromPath,
  imageViewedSource,
} from "../../ui/src/lib/chatActivities";

const media = (path: string) => `/api/media?path=${encodeURIComponent(path)}`;

describe("viewed image sources on Windows", () => {
  test("drive-letter snapshot paths load through the media route", () => {
    const snapshot = "C:\\Users\\cj\\.cybara\\media\\viewed\\0001\\shot.png";
    expect(imageSourceFromPath(snapshot)).toBe(media(snapshot));
    expect(imageSourceFromPath("D:/work/renders/mug.JPG")).toBe(media("D:/work/renders/mug.JPG"));
    expect(imageAltFromPath(snapshot)).toBe("shot.png");
  });

  test("UNC paths are treated as absolute local files", () => {
    const unc = "\\\\nas\\share\\captures\\frame.webp";
    expect(imageSourceFromPath(unc)).toBe(media(unc));
  });

  test("windows file URLs drop the leading slash before the drive letter", () => {
    expect(imageSourceFromPath("file:///C:/Users/cj/Pictures/cat%20one.png")).toBe(
      media("C:/Users/cj/Pictures/cat one.png")
    );
    expect(imageSourceFromPath("file://nas/share/frame.png")).toBe(
      media("\\\\nas\\share\\frame.png")
    );
  });

  test("tool results carrying Windows paths produce thumbnails", () => {
    expect(
      imageViewedSource({
        name: "read",
        result: { path: "C:\\repo\\docs\\a.png", snapshot: "C:\\cybara\\media\\viewed\\x\\a.png" },
      })
    ).toBe(media("C:\\cybara\\media\\viewed\\x\\a.png"));
  });

  test("relative, non-image, and drive-relative paths are rejected", () => {
    expect(imageSourceFromPath("docs\\a.png")).toBeUndefined();
    expect(imageSourceFromPath("C:a.png")).toBeUndefined();
    expect(imageSourceFromPath("C:\\notes\\readme.txt")).toBeUndefined();
    expect(imageSourceFromPath("file:///C:/notes/readme.txt")).toBeUndefined();
    expect(imageSourceFromPath("")).toBeUndefined();
    expect(imageSourceFromPath(undefined)).toBeUndefined();
  });

  test("POSIX paths keep working", () => {
    expect(imageSourceFromPath("/tmp/shot.png")).toBe(media("/tmp/shot.png"));
    expect(imageSourceFromPath("file:///Users/cj/shot.png")).toBe(media("/Users/cj/shot.png"));
  });
});
