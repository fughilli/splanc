# Exposes the Derivative TouchDesigner C++ SDK headers (vendored inside the
# CustomOperatorSamples repo, one copy per sample) as a single cc_library the
# //tools/touchdesigner/plugin shims can include. The headers are identical
# across samples; we point at one TOP sample and one CHOP sample so both the
# TOP and CHOP base classes are on the include path.

load("@rules_cc//cc:cc_library.bzl", "cc_library")

cc_library(
    name = "sdk",
    hdrs = [
        "CHOP/BasicFilterCHOP/CHOP_CPlusPlusBase.h",
        "TOP/OpticalFlowCPUTOP/CPlusPlus_Common.h",
        "TOP/OpticalFlowCPUTOP/TOP_CPlusPlusBase.h",
    ],
    includes = [
        "CHOP/BasicFilterCHOP",
        "TOP/OpticalFlowCPUTOP",
    ],
    visibility = ["//visibility:public"],
)
