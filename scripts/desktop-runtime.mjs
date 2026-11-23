import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function stageDesktopRuntime(exePath, { platform = process.platform, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform !== "win32") return exePath;
  if (typeof localAppData !== "string" || !path.isAbsolute(localAppData)) throw new Error("LOCALAPPDATA 必须是绝对路径，无法准备桌面运行目录");
  const names = [path.basename(exePath), "hwmusic-core.exe"];
  const contents = await Promise.all(names.map(name => readFile(path.join(path.dirname(exePath), name))));
  const identity = createHash("sha256");
  for (let index = 0; index < names.length; index += 1) identity.update(names[index]).update(contents[index]);
  const directory = path.join(localAppData, "HWMusic", "runtime", identity.digest("hex"));
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < names.length; index += 1) {
    const destination = path.join(directory, names[index]);
    try {
      await writeFile(destination, contents[index], { flag: "wx" });
    } catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
      if (!(await readFile(destination)).equals(contents[index])) throw new Error(`桌面运行副本内容不一致：${names[index]}`);
    }
  }
  return path.join(directory, names[0]);
}
