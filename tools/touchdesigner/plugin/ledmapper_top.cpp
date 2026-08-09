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
#include <utility>
#include <vector>

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
    if (!top) {
      in_w_ = in_h_ = 0;
      tdlm_status(handle_, &status_);
      return;
    }

    OP_TOPInputDownloadOptions opts;
    opts.verticalFlip = true;                        // TD textures are y-up
    opts.pixelFormat = OP_PixelFormat::BGRA8Fixed;   // 8-bit BGRA on the CPU
    OP_SmartRef<OP_TOPDownloadResult> down = top->downloadTexture(opts, nullptr);
    if (!down) return;

    const int width = top->textureDesc.width;
    const int height = top->textureDesc.height;
    const uint8_t* pixels = static_cast<const uint8_t*>(down->getData());
    const size_t len = static_cast<size_t>(width) * height * 4;

    // Cache the source dimensions for the INFO surfaces (which get no inputs).
    in_w_ = width;
    in_h_ = height;

    if (inputs->getParInt("Active") != 0 && pixels && width > 0 && height > 0) {
      // Push at the source resolution; the core rescales to the device's
      // declared texture size (or the manual fallback) before sending.
      tdlm_push_texture(handle_, pixels, len, static_cast<uint32_t>(width),
                        static_cast<uint32_t>(height));
    }

    // Refresh the status snapshot the INFO DAT/CHOP read back.
    tdlm_status(handle_, &status_);

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
    // Fallback texture size, used only when the device advertises no texture
    // dimensions for the configured port (older firmware). 0 = auto/pass-through.
    {
      OP_NumericParameter np("Devwidth");
      np.label = "Fallback Width";
      np.page = "LedMapper";
      np.defaultValues[0] = 0;
      np.minValues[0] = 0;
      np.clampMins[0] = true;
      manager->appendInt(np);
    }
    {
      OP_NumericParameter np("Devheight");
      np.label = "Fallback Height";
      np.page = "LedMapper";
      np.defaultValues[0] = 0;
      np.minValues[0] = 0;
      np.clampMins[0] = true;
      manager->appendInt(np);
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

  // --- INFO surfaces -------------------------------------------------------
  // These callbacks receive no OP_Inputs, so they read the snapshot cached by
  // the most recent execute() (status_ + in_w_/in_h_).

  void getWarningString(OP_String* warning, void*) override {
    if (mismatch()) {
      const std::string w = "Input " + dim(in_w_, in_h_) +
                            " != device texture " +
                            dim(status_.device_tex_w, status_.device_tex_h) +
                            " — rescaling (nearest-neighbour).";
      warning->setString(w.c_str());
    }
  }

  int32_t getNumInfoCHOPChans(void*) override {
    return static_cast<int32_t>(infoChans().size());
  }

  void getInfoCHOPChan(int32_t index, OP_InfoCHOPChan* chan, void*) override {
    const std::vector<Chan> chans = infoChans();
    if (index < 0 || index >= static_cast<int32_t>(chans.size())) return;
    chan->name->setString(chans[index].name);
    chan->value = chans[index].value;
  }

  bool getInfoDATSize(OP_InfoDATSize* size, void*) override {
    size->rows = static_cast<int32_t>(infoRows().size());
    size->cols = 2;
    size->byColumn = false;
    return true;
  }

  void getInfoDATEntries(int32_t index, int32_t nEntries,
                         OP_InfoDATEntries* entries, void*) override {
    const std::vector<std::pair<std::string, std::string>> rows = infoRows();
    if (index < 0 || index >= static_cast<int32_t>(rows.size())) return;
    entries->values[0]->setString(rows[index].first.c_str());
    if (nEntries > 1) entries->values[1]->setString(rows[index].second.c_str());
  }

 private:
  struct Chan {
    const char* name;
    float value;
  };

  static std::string dim(int w, int h) {
    return std::to_string(w) + "x" + std::to_string(h);
  }

  // A warning-worthy mismatch: the device declares a texture size and the input
  // TOP doesn't match it (the core is silently rescaling to compensate).
  bool mismatch() const {
    return status_.device_tex_w > 0 && status_.device_tex_h > 0 &&
           (static_cast<int>(status_.device_tex_w) != in_w_ ||
            static_cast<int>(status_.device_tex_h) != in_h_);
  }

  std::string statusTag() const {
    if (!status_.connected) return "not connected";
    if (status_.device_tex_w == 0 || status_.device_tex_h == 0)
      return "device size unknown (fallback/pass-through)";
    if (mismatch())
      return "MISMATCH: rescaling " + dim(in_w_, in_h_) + " -> " +
             dim(status_.device_tex_w, status_.device_tex_h);
    return "OK (match)";
  }

  std::vector<std::pair<std::string, std::string>> infoRows() const {
    std::vector<std::pair<std::string, std::string>> r;
    r.emplace_back("connected", status_.connected ? "true" : "false");
    r.emplace_back("device_name", status_.name);
    r.emplace_back("input_res", dim(in_w_, in_h_));
    r.emplace_back("device_res", (status_.device_tex_w && status_.device_tex_h)
                                     ? dim(status_.device_tex_w, status_.device_tex_h)
                                     : std::string("unknown"));
    r.emplace_back("target_res", dim(status_.target_w, status_.target_h));
    r.emplace_back("status", statusTag());
    r.emplace_back("frames_sent", std::to_string(status_.frames_sent));
    if (status_.error[0] != '\0') r.emplace_back("error", status_.error);
    return r;
  }

  std::vector<Chan> infoChans() const {
    return {
        {"connected", status_.connected ? 1.0f : 0.0f},
        {"frames_sent", static_cast<float>(status_.frames_sent)},
        {"device_w", static_cast<float>(status_.device_tex_w)},
        {"device_h", static_cast<float>(status_.device_tex_h)},
        {"input_w", static_cast<float>(in_w_)},
        {"input_h", static_cast<float>(in_h_)},
        {"target_w", static_cast<float>(status_.target_w)},
        {"target_h", static_cast<float>(status_.target_h)},
        {"mismatch", mismatch() ? 1.0f : 0.0f},
    };
  }

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

    // Manual fallback size (no reconnect): only used when the device reports no
    // texture dimensions for this port. 0 leaves the core in pass-through.
    const int dev_w = inputs->getParInt("Devwidth");
    const int dev_h = inputs->getParInt("Devheight");
    tdlm_set_target(handle_, static_cast<uint32_t>(dev_w > 0 ? dev_w : 0),
                    static_cast<uint32_t>(dev_h > 0 ? dev_h : 0));
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

  // Snapshot cached each cook for the INFO callbacks (no OP_Inputs there).
  int in_w_ = 0;
  int in_h_ = 0;
  TdlmStatus status_{};
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
