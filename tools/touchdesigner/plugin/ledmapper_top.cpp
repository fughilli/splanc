// TouchDesigner custom TOP: stream the input TOP's pixels to a fixture's
// texture input port over the ledmapper.v1 protocol.
//
// The heavy lifting (protocol, codec, discovery, networking) is in the Rust
// core (tools/touchdesigner/core); this shim only reads TouchDesigner's input
// pixels on the CPU and forwards them through the FFI. It runs in CPUMem
// execute mode and passes its input through to its output so the node doubles
// as a monitor of what it is sending.
//
// NOTE: built against the Derivative TouchDesigner C++ SDK (fetched via the
// @touchdesigner_sdk repo). It compiles where that SDK is available; behaviour
// must be validated inside TouchDesigner against a real fixture.

#include <cstdio>
#include <cstring>
#include <string>

#include "CPlusPlus_Common.h"
#include "TOP_CPlusPlusBase.h"
#include "ledmapper_ffi.h"

using namespace TD;

namespace {

const char* kFormats[] = {"rgb565", "rgb888", "rgb332", "gray8"};
const char* kFormatLabels[] = {"RGB565", "RGB888", "RGB332", "Gray8"};
constexpr int kNumFormats = 4;

class LedMapperTOP : public TOP_CPlusPlusBase {
 public:
  explicit LedMapperTOP(const OP_NodeInfo*, TOP_Context* context)
      : context_(context), handle_(tdlm_create()) {}

  ~LedMapperTOP() override { tdlm_destroy(handle_); }

  void getGeneralInfo(TOP_GeneralInfo* ginfo, const OP_Inputs*, void*) override {
    // Cook whenever the input updates so we keep streaming frames.
    ginfo->cookEveryFrame = false;
    ginfo->cookEveryFrameIfAsked = true;
    ginfo->inputSizeIndex = 0;
  }

  void execute(TOP_Output* output, const OP_Inputs* inputs, void*) override {
    applyConfig(inputs);

    const OP_TOPInput* top = inputs->getInputTOP(0);
    if (!top) return;

    OP_TOPInputDownloadOptions opts;
    opts.verticalFlip = true;                        // TD textures are y-up
    opts.pixelFormat = OP_PixelFormat::BGRA8Fixed;   // 8-bit BGRA on the CPU
    OP_SmartRef<OP_TOPDownloadResult> down = top->downloadTexture(opts, nullptr);
    if (!down) return;

    const int width = top->textureDesc.width;
    const int height = top->textureDesc.height;
    const uint8_t* pixels = static_cast<const uint8_t*>(down->getData());
    const size_t len = static_cast<size_t>(width) * height * 4;

    if (inputs->getParInt("Active") != 0 && pixels && width > 0 && height > 0) {
      tdlm_push_texture(handle_, pixels, len, static_cast<uint32_t>(width),
                        static_cast<uint32_t>(height));
    }

    passthrough(output, down, width, height);
  }

  void setupParameters(OP_ParameterManager* manager, void*) override {
    {
      OP_StringParameter sp("Host");
      sp.label = "Fixture Host";
      sp.page = "LedMapper";
      sp.defaultValue = "ledmapper.local";
      manager->appendString(sp);
    }
    {
      OP_NumericParameter np("Texindex");
      np.label = "Texture Port";
      np.page = "LedMapper";
      np.defaultValues[0] = 0;
      np.minValues[0] = 0;
      np.clampMins[0] = true;
      manager->appendInt(np);
    }
    {
      OP_StringParameter sp("Format");
      sp.label = "Format";
      sp.page = "LedMapper";
      sp.defaultValue = kFormats[0];
      manager->appendMenu(sp, kNumFormats, kFormats, kFormatLabels);
    }
    {
      OP_NumericParameter np("Rle");
      np.label = "RLE Compress";
      np.page = "LedMapper";
      np.defaultValues[0] = 1;
      manager->appendToggle(np);
    }
    {
      OP_StringParameter sp("Effect");
      sp.label = "Activate Effect";
      sp.page = "LedMapper";
      sp.defaultValue = "";
      manager->appendString(sp);
    }
    {
      OP_NumericParameter np("Active");
      np.label = "Active";
      np.page = "LedMapper";
      np.defaultValues[0] = 1;
      manager->appendToggle(np);
    }
  }

 private:
  void applyConfig(const OP_Inputs* inputs) {
    std::string host = str(inputs->getParString("Host"));
    int fmt_idx = inputs->getParInt("Format");
    if (fmt_idx < 0 || fmt_idx >= kNumFormats) fmt_idx = 0;
    std::string effect = str(inputs->getParString("Effect"));
    const int tex = inputs->getParInt("Texindex");
    const bool rle = inputs->getParInt("Rle") != 0;

    // Only reconfigure when something changed (a reconfigure reconnects).
    std::string sig = host + "|" + std::to_string(tex) + "|" +
                      kFormats[fmt_idx] + "|" + (rle ? "1" : "0") + "|" + effect;
    if (sig != last_config_) {
      tdlm_configure(handle_, host.c_str(), static_cast<uint32_t>(tex),
                     kFormats[fmt_idx], /*order=BGRA*/ 1, rle, effect.c_str());
      last_config_ = sig;
    }
  }

  // Re-upload the downloaded pixels so the node's output mirrors its input.
  void passthrough(TOP_Output* output, const OP_SmartRef<OP_TOPDownloadResult>& down,
                   int width, int height) {
    if (width <= 0 || height <= 0) return;
    const size_t bytes = static_cast<size_t>(width) * height * 4;
    OP_SmartRef<TOP_Buffer> buf =
        context_->createOutputBuffer(bytes, TOP_BufferFlags::None, nullptr);
    if (!buf) return;
    std::memcpy(buf->data, down->getData(), bytes);

    TOP_UploadInfo info;
    info.textureDesc.width = width;
    info.textureDesc.height = height;
    info.textureDesc.texDim = OP_TexDim::e2D;
    info.textureDesc.pixelFormat = OP_PixelFormat::BGRA8Fixed;
    info.colorBufferIndex = 0;
    output->uploadBuffer(&buf, info, nullptr);
  }

  static std::string str(const char* s) { return s ? std::string(s) : std::string(); }

  TOP_Context* context_ = nullptr;
  Handle* handle_ = nullptr;
  std::string last_config_;
};

}  // namespace

extern "C" {

DLLEXPORT void FillTOPPluginInfo(TOP_PluginInfo* info) {
  info->apiVersion = TOPCPlusPlusAPIVersion;
  info->executeMode = TOP_ExecuteMode::CPUMem;
  OP_CustomOPInfo& c = info->customOPInfo;
  c.opType->setString("Ledmappertexture");
  c.opLabel->setString("LedMapper Texture");
  c.authorName->setString("fughilli");
  c.authorEmail->setString("noreply@anthropic.com");
  c.minInputs = 1;
  c.maxInputs = 1;
}

DLLEXPORT TOP_CPlusPlusBase* CreateTOPInstance(const OP_NodeInfo* info,
                                               TOP_Context* context) {
  return new LedMapperTOP(info, context);
}

DLLEXPORT void DestroyTOPInstance(TOP_CPlusPlusBase* instance, TOP_Context*) {
  delete static_cast<LedMapperTOP*>(instance);
}

}  // extern "C"
