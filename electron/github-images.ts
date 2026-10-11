import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { githubImageFetchUrl } from "../src/lib/task-images";
import { fetchImageDataUrl, ImageAuthError } from "./image-proxy";

const execFileAsync = promisify(execFile);

/** `gh`'s token for image fetches; dropped when gh or GitHub refuses it. */
let imageTokenPromise: Promise<string> | null = null;

/**
 * Fetch an image embedded in an issue body with `gh`'s token and hand back
 * a data URL — a private repo's images 404 (or bounce to a login page)
 * without it. Only GitHub's own hosts get the token, on every redirect hop;
 * anything else throws and the renderer loads it directly.
 */
export async function proxyGitHubImage(url: string): Promise<string> {
  const target = githubImageFetchUrl(url);
  if (!target) throw new Error("Not a GitHub-hosted image");

  const token = await imageToken();
  try {
    return await fetchImageDataUrl({
      url: target,
      authorization: `token ${token}`,
      isTrusted: (hop) => githubImageFetchUrl(hop.href) !== null,
    });
  } catch (err) {
    // A token revoked or switched since it was cached; the next image asks gh again.
    if (err instanceof ImageAuthError) imageTokenPromise = null;
    throw err;
  }
}

/** `gh auth token`, run once and shared by every image rather than once per image. */
function imageToken(): Promise<string> {
  if (!imageTokenPromise) {
    imageTokenPromise = execFileAsync(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { encoding: "utf-8", timeout: 5000 },
    ).then(
      ({ stdout }) => stdout.trim(),
      (err: unknown) => {
        imageTokenPromise = null;
        throw err;
      },
    );
  }
  return imageTokenPromise;
}
