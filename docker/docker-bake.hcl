// docker buildx bake definition for the CC Workbench images.
//
//   docker buildx bake -f docker/docker-bake.hcl                      # every variant, linux/amd64, local tags
//   docker buildx bake -f docker/docker-bake.hcl web --set '*.platform=linux/amd64,linux/arm64'
//   RELEASE=2026.09.1 REVISION=$(git rev-parse HEAD) docker buildx bake -f docker/docker-bake.hcl --push
//
// The publish workflow builds one variant per platform on native runners and
// merges the results with imagetools instead of using this multi-platform path.

variable "REPOSITORY" {
  default = "docker.io/kongyo2/cc-workbench"
}

variable "RELEASE" {
  default = "0.0.0-dev"
}

variable "REVISION" {
  default = "unknown"
}

variable "BUILT_AT" {
  default = "1970-01-01T00:00:00Z"
}

variable "PLATFORMS" {
  default = "linux/amd64"
}

variable "TAG_SUFFIX" {
  default = ""
}

group "default" {
  targets = ["base", "web", "python", "go", "rust", "jvm", "ruby", "full"]
}

group "small" {
  targets = ["base", "web"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = split(",", PLATFORMS)
  args = {
    IMAGE_RELEASE   = RELEASE
    SOURCE_REVISION = REVISION
    BUILT_AT        = BUILT_AT
  }
}

target "base" {
  inherits = ["_common"]
  target   = "base"
  tags     = ["${REPOSITORY}:base-${RELEASE}${TAG_SUFFIX}"]
}

target "web" {
  inherits = ["_common"]
  target   = "web"
  tags     = ["${REPOSITORY}:web-${RELEASE}${TAG_SUFFIX}"]
}

target "python" {
  inherits = ["_common"]
  target   = "python"
  tags     = ["${REPOSITORY}:python-${RELEASE}${TAG_SUFFIX}"]
}

target "go" {
  inherits = ["_common"]
  target   = "go"
  tags     = ["${REPOSITORY}:go-${RELEASE}${TAG_SUFFIX}"]
}

target "rust" {
  inherits = ["_common"]
  target   = "rust"
  tags     = ["${REPOSITORY}:rust-${RELEASE}${TAG_SUFFIX}"]
}

target "jvm" {
  inherits = ["_common"]
  target   = "jvm"
  tags     = ["${REPOSITORY}:jvm-${RELEASE}${TAG_SUFFIX}"]
}

target "ruby" {
  inherits = ["_common"]
  target   = "ruby"
  tags     = ["${REPOSITORY}:ruby-${RELEASE}${TAG_SUFFIX}"]
}

target "full" {
  inherits = ["_common"]
  target   = "full"
  tags     = ["${REPOSITORY}:full-${RELEASE}${TAG_SUFFIX}"]
}
