import { createHash } from "crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "fs";
import { join, relative } from "path";

/** Content-address one installed Skill tree without following nested symlinks. */
export function skillTreeSha256(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split("\\").join("/");
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isSymbolicLink()) {
        hash.update(`L\0${relativePath}\0${readlinkSync(path)}\0`);
      } else if (stat.isFile()) {
        const content = readFileSync(path);
        hash.update(`F\0${relativePath}\0${content.length}\0`);
        hash.update(content);
        hash.update("\0");
      } else {
        throw new Error(`unsupported skill-tree entry type: ${relativePath}`);
      }
    }
  };
  walk(root);
  return `sha256:${hash.digest("hex")}`;
}
