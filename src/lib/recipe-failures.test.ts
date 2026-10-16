import { describe, expect, it } from "vitest";
import { classifyRecipeFailure } from "./recipe-failures";

const DOCKER_DESKTOP = { kind: "url", label: "Get Docker Desktop", href: "https://www.docker.com/products/docker-desktop/" };

const CASES: [name: string, output: string, summary: string, action?: unknown][] = [
  ["docker missing", "manor: the docker CLI was not found on PATH; install Docker and try again", "Docker isn't installed on this computer.", DOCKER_DESKTOP],
  ["docker not found (shell)", "up.sh: line 12: docker: command not found", "Docker isn't installed on this computer.", DOCKER_DESKTOP],
  ["daemon down", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", "Docker isn't running. Start it, then retry.", { kind: "retry" }],
  ["pull denied", "Error response from daemon: pull access denied for ghcr.io/orrybaram/manor-host, repository does not exist or may require 'docker login'", "Docker couldn't download Manor's host image.", { kind: "retry" }],
  ["manifest unknown", "Error response from daemon: manifest unknown: manifest unknown", "Docker couldn't download Manor's host image.", { kind: "retry" }],
  ["name in use", `docker: Error response from daemon: Conflict. The container name "/manor-50b660" is already in use by container "3f2a9c". You have to remove (or rename) that container to be able to reuse that name.`, "A container called manor-50b660 already exists."],
  ["disk full", "write /var/lib/docker/tmp/GetImageBlob: no space left on device", "Docker is out of disk space.", { kind: "url", label: "Docker's guide to freeing space", href: "https://docs.docker.com/engine/manage-resources/pruning/" }],
  ["mounts denied", "docker: Error response from daemon: Mounts denied: The path /Users/me/secret is not shared from the host", "Docker can't read a folder Manor shared with it."],
  ["socket permission", "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json\": dial unix /var/run/docker.sock: connect: permission denied", "Your user can't use Docker.", { kind: "url", label: "Docker's Linux setup steps", href: "https://docs.docker.com/engine/install/linux-postinstall/" }],
  ["wrong arch", "Error response from daemon: no matching manifest for linux/arm/v7 in the manifest list entries", "The host image wasn't built for this machine's CPU.", { kind: "retry" }],
  ["remote docker missing", `error during connect: Get "http://docker.example.com/v1.47/info": command [ssh -o ConnectTimeout=30 -T -l me -- build-box docker system dial-stdio] has exited with exit status 127, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=bash: line 1: docker: command not found`, "Docker isn't installed on build-box.", { kind: "url", label: "How to install Docker Engine", href: "https://docs.docker.com/engine/install/" }],
  ["remote ssh refused", `error during connect: Get "http://docker.example.com/v1.47/info": command [ssh -o ConnectTimeout=30 -T -- build-box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=ssh: connect to host build-box port 22: Connection refused`, "Manor couldn't reach build-box over SSH.", { kind: "retry" }],
  ["remote ssh (docker 29)", `error during connect: Get "http://docker.example.com/v1.52/info": command [ssh -l me -p 22386 -o ConnectTimeout=30 -T -- 127.0.0.1 docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=Host key verification failed.`, "Manor couldn't reach 127.0.0.1 over SSH.", { kind: "retry" }],
  ["remote ssh unresolved", "error during connect: ssh: Could not resolve hostname nowhere: Name or service not known", "Manor couldn't reach nowhere over SSH.", { kind: "retry" }],
  ["remote socket permission", `error during connect: command [ssh -T -- build-box docker system dial-stdio] has exited with exit status 1, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock`, "Your user can't use Docker.", { kind: "url", label: "Docker's Linux setup steps", href: "https://docs.docker.com/engine/install/linux-postinstall/" }],
  ["kubectl missing", "manor: kubectl was not found on PATH; install it and try again", "Manor needs kubectl to talk to the cluster.", { kind: "url", label: "Install kubectl", href: "https://kubernetes.io/docs/tasks/tools/" }],
  ["exec plugin", "Unable to connect to the server: getting credentials: exec: executable aws not found", "This cluster signs in through aws, and Manor can't find it."],
  ["forbidden", `Error from server (Forbidden): pods is forbidden: User "me" cannot create resource "pods" in API group "" in the namespace "dev"`, "Your account isn't allowed to do that on this cluster."],
  ["pod security", `Error from server (Forbidden): pods "manor" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false`, "This namespace only allows locked-down pods."],
  ["no room", "manor: 0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes are available", "No computer in the cluster has room for this host. Try a smaller size."],
  ["image pull", `manor: Failed to pull image "ghcr.io/x/y:1": ErrImagePull`, "The cluster couldn't download the host image."],
  ["backoff", "manor: ImagePullBackOff: Back-off pulling image", "The cluster couldn't download the host image."],
  ["oom", "manor: container manor terminated: OOMKilled", "The host ran out of memory. Try a larger size."],
  ["storage class", `manor: storageclass.storage.k8s.io "nope" not found`, "The cluster couldn't give this host a disk."],
  ["unbound claim", "manor: pod has unbound immediate PersistentVolumeClaims", "The cluster couldn't give this host a disk."],
  ["timeout", "manor: the host's pod still wasn't ready after 14 minutes; it was stuck at: Starting the container", "The host didn't start in 14 minutes. It was stuck at: Starting the container."],
];

describe("classifyRecipeFailure", () => {
  it.each(CASES)("%s", (_name, output, summary, action) => {
    const got = classifyRecipeFailure(output);
    expect(got?.summary).toBe(summary);
    expect(got?.action).toEqual(action);
  });

  it("returns null for output nothing recognises", () => {
    expect(classifyRecipeFailure("manor: something odd happened")).toBeNull();
  });

  it("reads only the last 4 KB", () => {
    const old = "docker: command not found\n" + "x".repeat(5000);
    expect(classifyRecipeFailure(old)).toBeNull();
  });

  it("prefers the specific pattern over a general one", () => {
    const out = `pods "m" is forbidden: violates PodSecurity "restricted:latest"`;
    expect(classifyRecipeFailure(out)?.summary).toBe("This namespace only allows locked-down pods.");
  });
});
