/* @ts-self-types="./pulse_wasm_pkg.d.ts" */

export class EffectSim {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EffectSimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_effectsim_free(ptr, 0);
    }
    /**
     * Live pulse count (HUD / diagnostics).
     * @returns {number}
     */
    active_pulses() {
        const ret = wasm.effectsim_active_pulses(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Flood wavefront distance, mm (HUD / diagnostics).
     * @returns {number}
     */
    flood_front_mm() {
        const ret = wasm.effectsim_flood_front_mm(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Build a sim.
     *
     * Segments: parallel arrays `seg_a[i]`, `seg_b[i]` (branch-point ids ≥ 0,
     * or -1 for a free end) and `seg_len_mm[i]`. Per-LED association: parallel
     * arrays `led_seg[i]` (segment INDEX), `led_s_mm[i]` (foot arclength from
     * node a), `led_dperp_mm[i]` (perpendicular offset). `effect`: 0 = pulse,
     * 1 = flood. Config is in human units (meters, m/s, [0,1]); `lead_m`/
     * `decay_m` ≤ 0 derive from the glow radius, `split_prob` < 0 uses the
     * default. `palette_rgb` is 0xRRGGBB (empty → white).
     * @param {Int32Array} seg_a
     * @param {Int32Array} seg_b
     * @param {Uint32Array} seg_len_mm
     * @param {Uint32Array} led_seg
     * @param {Uint32Array} led_s_mm
     * @param {Uint32Array} led_dperp_mm
     * @param {number} effect
     * @param {number} intensity
     * @param {number} glow_m
     * @param {number} speed_m_s
     * @param {number} agent_count
     * @param {number} lead_m
     * @param {number} split_prob
     * @param {number} decay_m
     * @param {Uint32Array} palette_rgb
     * @param {number} seed
     */
    constructor(seg_a, seg_b, seg_len_mm, led_seg, led_s_mm, led_dperp_mm, effect, intensity, glow_m, speed_m_s, agent_count, lead_m, split_prob, decay_m, palette_rgb, seed) {
        const ptr0 = passArray32ToWasm0(seg_a, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(seg_b, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(seg_len_mm, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(led_seg, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(led_s_mm, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(led_dperp_mm, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray32ToWasm0(palette_rgb, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.effectsim_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, effect, intensity, glow_m, speed_m_s, agent_count, lead_m, split_prob, decay_m, ptr6, len6, seed);
        this.__wbg_ptr = ret;
        EffectSimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render every LED to a flat RGB byte array (length = led_count * 3), in
     * the association order passed to `new`.
     * @returns {Uint8Array}
     */
    render() {
        const ret = wasm.effectsim_render(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Adopt a new effect config on the RUNNING sim without resetting animation
     * state (smooth live tuning). Same arg order as the constructor's config
     * tail. A change of effect kind (pulse↔flood) re-initialises that effect.
     * @param {number} effect
     * @param {number} intensity
     * @param {number} glow_m
     * @param {number} speed_m_s
     * @param {number} agent_count
     * @param {number} lead_m
     * @param {number} split_prob
     * @param {number} decay_m
     * @param {Uint32Array} palette_rgb
     */
    set_config(effect, intensity, glow_m, speed_m_s, agent_count, lead_m, split_prob, decay_m, palette_rgb) {
        const ptr0 = passArray32ToWasm0(palette_rgb, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.effectsim_set_config(this.__wbg_ptr, effect, intensity, glow_m, speed_m_s, agent_count, lead_m, split_prob, decay_m, ptr0, len0);
    }
    /**
     * Advance the simulation by `dt_ms`.
     * @param {number} dt_ms
     */
    step(dt_ms) {
        wasm.effectsim_step(this.__wbg_ptr, dt_ms);
    }
}
if (Symbol.dispose) EffectSim.prototype[Symbol.dispose] = EffectSim.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./pulse_wasm_pkg_bg.js": import0,
    };
}

const EffectSimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_effectsim_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('pulse_wasm_pkg_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
