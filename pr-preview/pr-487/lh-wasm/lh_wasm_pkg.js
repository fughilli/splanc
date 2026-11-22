/* @ts-self-types="./lh_wasm_pkg.d.ts" */

export class LhTracker {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LhTrackerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lhtracker_free(ptr, 0);
    }
    /**
     * A HID device was opened: its handle, or 0 if it isn't a known Vive device.
     * @param {number} vid
     * @param {number} pid
     * @returns {number}
     */
    add_device(vid, pid) {
        const ret = wasm.lhtracker_add_device(this.__wbg_ptr, vid, pid);
        return ret >>> 0;
    }
    /**
     * The events since the last call, a JSON array (see core.rs drain_kernel).
     * @returns {string}
     */
    drain() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.lhtracker_drain(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The next handshake step, JSON:
     *   {"step":"pending","sets":[[…]],"delay_ms":n,"get":id,"len":n}
     *   {"step":"ready","sets":[[…]],"serial":"…"}
     *   {"step":"failed","why":"…"}
     * @param {number} handle
     * @returns {string}
     */
    handshake(handle) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.lhtracker_handshake(this.__wbg_ptr, handle);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The answer to the pending GET `report_id`: `status` 0 = ok (`data`, report id
     * first), 1 = NAK / not answered (retried), 2 = device gone.
     * @param {number} handle
     * @param {number} report_id
     * @param {number} status
     * @param {Uint8Array} data
     */
    handshake_answer(handle, report_id, status, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.lhtracker_handshake_answer(this.__wbg_ptr, handle, report_id, status, ptr0, len0);
    }
    /**
     * `host_clock`: map device clocks onto report arrival times (lhd --host-clock);
     * `stream`: with it, stream sweeps into the filter (lhd --stream-sweeps, the P4).
     * @param {boolean} host_clock
     * @param {boolean} stream
     */
    constructor(host_clock, stream) {
        const ret = wasm.lhtracker_new(host_clock, stream);
        this.__wbg_ptr = ret;
        LhTrackerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    recalibrate() {
        wasm.lhtracker_recalibrate(this.__wbg_ptr);
    }
    /**
     * @param {number} handle
     */
    remove_device(handle) {
        wasm.lhtracker_remove_device(this.__wbg_ptr, handle);
    }
    /**
     * One input report (report id first) from HID interface `interface` (a dongle: 0),
     * arrived at `host_us` (µs, the page's performance.now() * 1000).
     * @param {number} handle
     * @param {number} _interface
     * @param {Uint8Array} data
     * @param {number} host_us
     */
    report(handle, _interface, data, host_us) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.lhtracker_report(this.__wbg_ptr, handle, _interface, ptr0, len0, host_us);
    }
    /**
     * Many reports in one call (fewer crossings, and one worker message):
     * `packed` is [handle u32 LE, interface i32 LE, host_us f64 LE, len u16 LE, bytes…]*.
     * @param {Uint8Array} packed
     */
    reports(packed) {
        const ptr0 = passArray8ToWasm0(packed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.lhtracker_reports(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Forget the stations: calibrate from still scenes again.
     */
    reset() {
        wasm.lhtracker_reset(this.__wbg_ptr);
    }
    /**
     * A saved station: `pose` [x y z qw qx qy qz] (world <- station, m), `cov` 36,
     * `cal` 10 numbers ([phase tilt curve gibphase gibmag] per axis) or empty.
     * @param {number} id
     * @param {Float64Array} pose
     * @param {Float64Array} cov
     * @param {Float64Array} cal
     */
    station_prior(id, pose, cov, cal) {
        const ptr0 = passArrayF64ToWasm0(pose, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(cov, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(cal, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.lhtracker_station_prior(this.__wbg_ptr, id, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Housekeeping (~10 Hz): quiet wireless devices, health aging. Returns the handles
     * whose tracker went away (handshake them again).
     * @param {number} host_us
     * @returns {Uint32Array}
     */
    tick(host_us) {
        const ret = wasm.lhtracker_tick(this.__wbg_ptr, host_us);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) LhTracker.prototype[Symbol.dispose] = LhTracker.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
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
        "./lh_wasm_pkg_bg.js": import0,
    };
}

const LhTrackerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lhtracker_free(ptr, 1));

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
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

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
    cachedFloat64ArrayMemory0 = null;
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
        module_or_path = new URL('lh_wasm_pkg_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
