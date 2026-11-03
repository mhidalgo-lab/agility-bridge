# Verify a release

> Every command on this page was run against the published release **0.8.0** on 2026-11-03 (P9-07) with `gh` 2.103,
> npm 11.16 and Docker buildx; all exited 0. The same steps verify a backport release (`0.8.x` from a `release/0.8`
> branch). You need `gh` (logged in: attestation verification calls the GitHub API), `npm`, `sha256sum`, `jq` and, for
> the image, Docker.

Every [GitHub Release](https://github.com/mhidalgo-lab/agility-bridge/releases) of agility-bridge carries:

| Asset | What it is |
| --- | --- |
| `agility-bridge-<v>.tgz` | The npm tarball, byte for byte what is published on npm. |
| `agility-bridge-<v>.cdx.json` | CycloneDX SBOM of the production dependencies. |
| `SHA256SUMS` | Checksums of the files above. |
| `agility-bridge-<v>.intoto.jsonl` | Sigstore bundle of the build provenance attestation covering the three files above. |

The attestation is created by the release workflow (`.github/workflows/release.yml`) with GitHub OIDC and Sigstore.
It states which repository, workflow, branch and commit built the files.

**`gh attestation verify` prints nothing when its output is not a terminal** (scripts, CI, pipes) and signals success
only through its exit status (`0`). Check `$?`, or add `--format json` to see the evidence. Below, every `verify` is
followed by an exit-status check for that reason.

## 1. Download and check the checksums

```bash
mkdir verify && cd verify
gh release download v0.8.0 -R mhidalgo-lab/agility-bridge     # use the version you are checking
sha256sum -c SHA256SUMS
```

Expected: `agility-bridge-0.8.0.cdx.json: OK` and `agility-bridge-0.8.0.tgz: OK`. A checksum file proves nothing by
itself (it came from the same place); the next step ties the files to the workflow run.

## 2. Verify the build provenance

```bash
gh attestation verify agility-bridge-0.8.0.tgz -R mhidalgo-lab/agility-bridge; echo "exit=$?"
```

To pin what you accept (the exact workflow, the branch and GitHub-hosted runners) and to read the commit that built it:

```bash
gh attestation verify agility-bridge-0.8.0.tgz -R mhidalgo-lab/agility-bridge \
  --signer-workflow mhidalgo-lab/agility-bridge/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners --format json \
  | jq '.[0].verificationResult.signature.certificate | {sourceRepositoryRef, sourceRepositoryDigest, buildSignerURI}'
```

`sourceRepositoryDigest` is the commit; it must equal the commit of the release tag (`git ls-remote
https://github.com/mhidalgo-lab/agility-bridge 'refs/tags/v0.8.0*'`; for an annotated tag use the peeled `^{}` line).
For a backport, use `--source-ref refs/heads/release/0.8` (the minor line you downloaded).

The checksum file and the SBOM are covered by the same attestation:

```bash
gh attestation verify SHA256SUMS -R mhidalgo-lab/agility-bridge; echo "exit=$?"
gh attestation verify agility-bridge-0.8.0.cdx.json -R mhidalgo-lab/agility-bridge; echo "exit=$?"
```

`gh attestation verify` fetches the attestation from GitHub. To verify offline with the downloaded bundle:

```bash
gh attestation verify agility-bridge-0.8.0.tgz -R mhidalgo-lab/agility-bridge \
  --bundle agility-bridge-0.8.0.intoto.jsonl; echo "exit=$?"
```

## 3. The SBOM

A second attestation binds the SBOM to the tarball. Verify it, and look at what the SBOM lists:

```bash
gh attestation verify agility-bridge-0.8.0.tgz -R mhidalgo-lab/agility-bridge \
  --predicate-type https://cyclonedx.org/bom; echo "exit=$?"
jq '{format: .bomFormat, spec: .specVersion, components: (.components | length)}' agility-bridge-0.8.0.cdx.json
```

The SBOM lists the production dependencies of the published package (the CLI bundles its workspace packages, so the
list is short: 10 components for 0.8.0). It does not list development tools.

## 4. The npm package

npm provenance links the package to the same workflow run. The tarball on npm and the one on the GitHub Release are
identical:

```bash
npm view agility-bridge@0.8.0 dist.integrity dist.attestations
echo "sha512-$(openssl dgst -sha512 -binary agility-bridge-0.8.0.tgz | base64 -w0)"
```

The two `sha512-…` values must be equal, and `dist.attestations.provenance.predicateType` is
`https://slsa.dev/provenance/v1`. To check the registry signatures and provenance of what you install:

```bash
mkdir ../npmcheck && cd ../npmcheck && npm init -y >/dev/null
npm install agility-bridge@0.8.0 --ignore-scripts
npm audit signatures
```

Expected: `verified registry signatures` for all installed packages and `verified attestations` for those that publish
provenance (agility-bridge among them). You can also open the package page on npmjs.com (*Provenance*).

## 5. The Docker image

Releases from v0.2 also publish `ghcr.io/mhidalgo-lab/agility-bridge` (`linux/amd64`, `linux/arm64`) with tags `X.Y.Z`
and `X.Y`, and `latest` from the newest release of `main` only (never from a backport). Its build provenance and an SBOM
attestation are stored in the registry, signed with GitHub OIDC and Sigstore by the same workflow.

```bash
gh attestation verify oci://ghcr.io/mhidalgo-lab/agility-bridge:0.8.0 -R mhidalgo-lab/agility-bridge; echo "exit=$?"
gh attestation verify oci://ghcr.io/mhidalgo-lab/agility-bridge:0.8.0 -R mhidalgo-lab/agility-bridge \
  --predicate-type https://cyclonedx.org/bom; echo "exit=$?"
docker buildx imagetools inspect ghcr.io/mhidalgo-lab/agility-bridge:0.8.0 --format '{{.Manifest.Digest}}'
```

The last command prints the index digest (`sha256:6ecf6d95…` for 0.8.0). **Pin that digest** in your deployment
(`image: ghcr.io/mhidalgo-lab/agility-bridge@sha256:…`) and verify the digest reference, which cannot move:

```bash
gh attestation verify oci://ghcr.io/mhidalgo-lab/agility-bridge@sha256:<digest> -R mhidalgo-lab/agility-bridge; echo "exit=$?"
```

The SBOM attestation lists the application's production dependencies (what `/app` holds); the base image is distroless
Node 24, pinned by digest in `docker/Dockerfile`. `cosign` is not part of this guide: `gh attestation verify` is the
tested path, and we do not document commands we have not run.

## What a failure means

| You see | Meaning |
|---|---|
| `sha256sum` reports FAILED | A corrupted or replaced download. Download again; if it persists, report it privately ([SECURITY.md](../../SECURITY.md)). |
| `gh attestation verify` exits non-zero with *no attestations found* | The file is not one the release workflow built (renamed, rebuilt, or a different version). Do not use it. |
| The `--signer-workflow` or `--source-ref` check fails | It was built by another workflow or branch than you expect. For a backport, the ref is `refs/heads/release/<x.y>`, not `main`. |
| The npm integrity differs from the release tarball's | The package on npm is not the one the release built. Do not install it; report it privately. |
| `HTTP 404` for `--predicate-type https://spdx.dev/...` | The SBOM is CycloneDX, not SPDX; use `https://cyclonedx.org/bom`. |
