# Verify a release

Every [GitHub Release](https://github.com/mhidalgo-lab/agility-bridge/releases) of agility-bridge carries:

| Asset | What it is |
| --- | --- |
| `agility-bridge-<v>.tgz` | The npm tarball, byte for byte what is published on npm. |
| `agility-bridge-<v>.cdx.json` | CycloneDX SBOM of the production dependencies. |
| `SHA256SUMS` | Checksums of the files above. |
| `agility-bridge-<v>.intoto.jsonl` | Sigstore bundle of the build provenance attestation covering the three files above. |

The attestation is created by the release workflow (`.github/workflows/release.yml`) with GitHub OIDC and Sigstore.
It states which repository, workflow and commit built the files.

```bash
V=0.1.0   # the release you downloaded
gh release download "v$V" -R mhidalgo-lab/agility-bridge
sha256sum -c SHA256SUMS
gh attestation verify "agility-bridge-$V.tgz" -R mhidalgo-lab/agility-bridge
```

`gh attestation verify` fetches the attestation from GitHub. To verify offline with the downloaded bundle (a release
that has the `.intoto.jsonl` asset):

```bash
gh attestation verify "agility-bridge-$V.tgz" -R mhidalgo-lab/agility-bridge \
  --bundle "agility-bridge-$V.intoto.jsonl"
```

## The Docker image

Releases from v0.2 also publish `ghcr.io/mhidalgo-lab/agility-bridge` (`linux/amd64`, `linux/arm64`) with tags
`X.Y.Z`, `X.Y` and `latest`. Its build provenance and an SBOM attestation are stored in the registry, signed with
GitHub OIDC and Sigstore by the same workflow. Pin the digest you verified:

```bash
V=0.2.0
gh attestation verify "oci://ghcr.io/mhidalgo-lab/agility-bridge:$V" -R mhidalgo-lab/agility-bridge
docker buildx imagetools inspect "ghcr.io/mhidalgo-lab/agility-bridge:$V" --format '{{json .Manifest.Digest}}'
```

The SBOM attestation lists the application's production dependencies (what `/app` holds); the base image is
distroless Node 24, pinned by digest in `docker/Dockerfile`.

## The npm package

The npm package also carries npm provenance, linking it to the same workflow run: after installing, run
`npm audit signatures`, or open the package page on npmjs.com (*Provenance*). The tarball on npm and the one on the
GitHub Release are identical: compare `npm view agility-bridge@$V dist.integrity` with
`echo "sha512-$(openssl dgst -sha512 -binary agility-bridge-$V.tgz | base64 -w0)"`.
