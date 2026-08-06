// TouchDesigner custom CHOP: drive a fixture's shader uniforms from CHOP
// channels over the ledmapper.v1 protocol.
//
// Each input channel's last sample is read as a value; the Rust core maps the
// named channels onto the active effect's uniform slots using the manifest it
// fetched from the fixture (float / bool / vecN — a vec's components are the
// channels `name:x`, `name:y`, ...). When the device advertises no manifest
// (current firmware), channels named `slotN` drive slot N directly. The input
// is passed through to the output so the node is transparent in a chain.
//
// NOTE: built against the Derivative TouchDesigner C++ SDK (@touchdesigner_sdk).
// Compiles where that SDK is available; validate inside TouchDesigner.

#include <string>
#include <vector>

#include "CHOP_CPlusPlusBase.h"
#include "CPlusPlus_Common.h"
#include "ledmapper_ffi.h"

using namespace TD;

namespace {

class LedMapperCHOP : public CHOP_CPlusPlusBase {
 public:
  explicit LedMapperCHOP(const OP_NodeInfo*) : handle_(tdlm_create()) {}
  ~LedMapperCHOP() override { tdlm_destroy(handle_); }

  void getGeneralInfo(CHOP_GeneralInfo* ginfo, const OP_Inputs*, void*) override {
    ginfo->cookEveryFrame = false;
    ginfo->cookEveryFrameIfAsked = true;
    ginfo->timeslice = false;
    ginfo->inputMatchIndex = 0;
  }

  // Output matches the input (pass-through), so no explicit output info.
  bool getOutputInfo(CHOP_OutputInfo*, const OP_Inputs*, void*) override {
    return false;
  }

  void getChannelName(int32_t index, OP_String* name, const OP_Inputs* inputs,
                      void*) override {
    const OP_CHOPInput* in = inputs->getInputCHOP(0);
    if (in && index < in->numChannels) {
      name->setString(in->getChannelName(index));
    } else {
      name->setString("chan1");
    }
  }

  void execute(CHOP_Output* output, const OP_Inputs* inputs, void*) override {
    applyConfig(inputs);

    const OP_CHOPInput* in = inputs->getInputCHOP(0);
    if (!in) return;

    if (inputs->getParInt("Active") != 0) {
      // Collect each channel's most recent sample as (name, value).
      std::vector<const char*> names;
      std::vector<float> values;
      names.reserve(in->numChannels);
      values.reserve(in->numChannels);
      const int last = in->numSamples > 0 ? in->numSamples - 1 : 0;
      for (int c = 0; c < in->numChannels; ++c) {
        names.push_back(in->getChannelName(c));
        values.push_back(in->channelData[c][last]);
      }
      tdlm_drive_uniforms(handle_, names.data(), values.data(),
                          static_cast<uint32_t>(names.size()));
    }

    // Pass the input through unchanged.
    for (int i = 0; i < output->numChannels; ++i) {
      const int src = i < in->numChannels ? i : in->numChannels - 1;
      for (int j = 0; j < output->numSamples; ++j) {
        const int s = j < in->numSamples ? j : in->numSamples - 1;
        output->channels[i][j] = in->channelData[src][s];
      }
    }
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
    std::string effect = str(inputs->getParString("Effect"));
    std::string sig = host + "|" + effect;
    if (sig != last_config_) {
      // Texture params are irrelevant to the CHOP; pass benign defaults.
      tdlm_configure(handle_, host.c_str(), 0, "rgb565", 1, true, effect.c_str());
      last_config_ = sig;
    }
  }

  static std::string str(const char* s) { return s ? std::string(s) : std::string(); }

  Handle* handle_ = nullptr;
  std::string last_config_;
};

}  // namespace

extern "C" {

DLLEXPORT void FillCHOPPluginInfo(CHOP_PluginInfo* info) {
  info->apiVersion = CHOPCPlusPlusAPIVersion;
  OP_CustomOPInfo& c = info->customOPInfo;
  c.opType->setString("Ledmapperuniforms");
  c.opLabel->setString("LedMapper Uniforms");
  c.authorName->setString("fughilli");
  c.authorEmail->setString("noreply@anthropic.com");
  c.minInputs = 1;
  c.maxInputs = 1;
}

DLLEXPORT CHOP_CPlusPlusBase* CreateCHOPInstance(const OP_NodeInfo* info) {
  return new LedMapperCHOP(info);
}

DLLEXPORT void DestroyCHOPInstance(CHOP_CPlusPlusBase* instance) {
  delete static_cast<LedMapperCHOP*>(instance);
}

}  // extern "C"
