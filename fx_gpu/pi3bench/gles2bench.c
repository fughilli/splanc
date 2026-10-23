// gles2bench — GLES2 offscreen render + readback microbenchmark for one
// fx_gpu kernel on one LED layout (docs/design/fx-gpu-lowering.md, step 2).
//
//   gles2bench VS.glsl FS.glsl PACK.fxp [--frames N] [--name K] [--layout CxP]
//
// Surfaceless EGL (EGL_PLATFORM_SURFACELESS_MESA, no display) on the vc4 render
// node; the kernel runs in the vertex shader, one GL_POINTS vertex per LED, into
// a W x H RGBA8 texture FBO (W = LEDs per channel, H = channels). Per frame it
// times render (uniform upload + draw + glFinish) and readback (glReadPixels)
// separately, then checks the check frames byte-for-byte against the VM golden
// in the pack. Extra passes time readback formats (RGBA8, the implementation's
// preferred format, RGB565 target) and a pipelined draw+read loop.
// EGL/GLES are dlopen()ed, so no headers or link-time Mesa are needed.
// Prints ONE JSON object on stdout; diagnostics go to stderr.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef void *EGLDisplay, *EGLConfig, *EGLContext, *EGLSurface;
typedef int32_t EGLint;
typedef unsigned int EGLenum, EGLBoolean;
typedef unsigned int GLuint, GLenum, GLbitfield;
typedef int GLint, GLsizei;
typedef float GLfloat;
typedef char GLchar;
typedef unsigned char GLubyte;
typedef long GLsizeiptr;

#define EGL_NONE 0x3038
#define EGL_RENDERABLE_TYPE 0x3040
#define EGL_SURFACE_TYPE 0x3033
#define EGL_PBUFFER_BIT 0x0001
#define EGL_OPENGL_ES2_BIT 0x0004
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#define EGL_VENDOR 0x3053
#define EGL_VERSION 0x3054

#define GL_VERTEX_SHADER 0x8B31
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_FRAMEBUFFER 0x8D40
#define GL_RENDERBUFFER 0x8D41
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_NEAREST 0x2600
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_RGB565 0x8D62
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT_5_6_5 0x8363
#define GL_ARRAY_BUFFER 0x8892
#define GL_STATIC_DRAW 0x88E4
#define GL_FLOAT 0x1406
#define GL_POINTS 0x0000
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_VENDOR 0x1F00
#define GL_IMPLEMENTATION_COLOR_READ_TYPE 0x8B9A
#define GL_IMPLEMENTATION_COLOR_READ_FORMAT 0x8B9B
#define GL_MAX_TEXTURE_SIZE 0x0D33
#define GL_MAX_VIEWPORT_DIMS 0x0D3A
#define GL_MAX_VERTEX_ATTRIBS 0x8869
#define GL_PACK_ALIGNMENT 0x0D05

static void *egl_lib, *gl_lib;
#define F(ret, name, args) static ret(*p_##name) args;
F(void *, eglGetProcAddress, (const char *))
F(EGLDisplay, eglGetPlatformDisplayEXT, (EGLenum, void *, const EGLint *))
F(EGLBoolean, eglInitialize, (EGLDisplay, EGLint *, EGLint *))
F(EGLBoolean, eglBindAPI, (EGLenum))
F(EGLBoolean, eglChooseConfig, (EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *))
F(EGLContext, eglCreateContext, (EGLDisplay, EGLConfig, EGLContext, const EGLint *))
F(EGLBoolean, eglMakeCurrent, (EGLDisplay, EGLSurface, EGLSurface, EGLContext))
F(const char *, eglQueryString, (EGLDisplay, EGLint))
F(EGLint, eglGetError, (void))
F(EGLBoolean, eglTerminate, (EGLDisplay))
F(const GLubyte *, glGetString, (GLenum))
F(void, glGetIntegerv, (GLenum, GLint *))
F(GLuint, glCreateShader, (GLenum))
F(void, glShaderSource, (GLuint, GLsizei, const GLchar *const *, const GLint *))
F(void, glCompileShader, (GLuint))
F(void, glGetShaderiv, (GLuint, GLenum, GLint *))
F(void, glGetShaderInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *))
F(GLuint, glCreateProgram, (void))
F(void, glAttachShader, (GLuint, GLuint))
F(void, glBindAttribLocation, (GLuint, GLuint, const GLchar *))
F(void, glLinkProgram, (GLuint))
F(void, glGetProgramiv, (GLuint, GLenum, GLint *))
F(void, glGetProgramInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *))
F(void, glUseProgram, (GLuint))
F(GLint, glGetUniformLocation, (GLuint, const GLchar *))
F(void, glUniform1f, (GLint, GLfloat))
F(void, glGenFramebuffers, (GLsizei, GLuint *))
F(void, glBindFramebuffer, (GLenum, GLuint))
F(void, glFramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint))
F(void, glFramebufferRenderbuffer, (GLenum, GLenum, GLenum, GLuint))
F(GLenum, glCheckFramebufferStatus, (GLenum))
F(void, glGenRenderbuffers, (GLsizei, GLuint *))
F(void, glBindRenderbuffer, (GLenum, GLuint))
F(void, glRenderbufferStorage, (GLenum, GLenum, GLsizei, GLsizei))
F(void, glGenTextures, (GLsizei, GLuint *))
F(void, glBindTexture, (GLenum, GLuint))
F(void, glTexParameteri, (GLenum, GLenum, GLint))
F(void, glTexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *))
F(void, glGenBuffers, (GLsizei, GLuint *))
F(void, glBindBuffer, (GLenum, GLuint))
F(void, glBufferData, (GLenum, GLsizeiptr, const void *, GLenum))
F(void, glEnableVertexAttribArray, (GLuint))
F(void, glVertexAttribPointer, (GLuint, GLint, GLenum, GLubyte, GLsizei, const void *))
F(void, glViewport, (GLint, GLint, GLsizei, GLsizei))
F(void, glDrawArrays, (GLenum, GLint, GLsizei))
F(void, glFinish, (void))
F(void, glPixelStorei, (GLenum, GLint))
F(void, glReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *))
F(GLenum, glGetError, (void))
#undef F

static void die(const char *m) {
  fprintf(stderr, "gles2bench: %s\n", m);
  printf("{\"bench\":\"gles2\",\"ok\":false,\"error\":\"%s\"}\n", m);
  exit(2);
}

static void *sym(void *lib, const char *n) {
  void *p = dlsym(lib, n);
  if (!p && p_eglGetProcAddress) p = p_eglGetProcAddress(n);
  if (!p) {
    fprintf(stderr, "missing symbol %s\n", n);
    die("missing GL/EGL symbol");
  }
  return p;
}

static void load(void) {
  egl_lib = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!egl_lib) die("dlopen libEGL.so.1 failed");
  gl_lib = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_GLOBAL);
  if (!gl_lib) die("dlopen libGLESv2.so.2 failed");
#define LE(n) p_##n = sym(egl_lib, #n)
#define LG(n) p_##n = sym(gl_lib, #n)
  LE(eglGetProcAddress);
  p_eglGetPlatformDisplayEXT = p_eglGetProcAddress("eglGetPlatformDisplayEXT");
  if (!p_eglGetPlatformDisplayEXT) die("no eglGetPlatformDisplayEXT");
  LE(eglInitialize); LE(eglBindAPI); LE(eglChooseConfig); LE(eglCreateContext);
  LE(eglMakeCurrent); LE(eglQueryString); LE(eglGetError); LE(eglTerminate);
  LG(glGetString); LG(glGetIntegerv); LG(glCreateShader); LG(glShaderSource);
  LG(glCompileShader); LG(glGetShaderiv); LG(glGetShaderInfoLog); LG(glCreateProgram);
  LG(glAttachShader); LG(glBindAttribLocation); LG(glLinkProgram); LG(glGetProgramiv);
  LG(glGetProgramInfoLog); LG(glUseProgram); LG(glGetUniformLocation); LG(glUniform1f);
  LG(glGenFramebuffers); LG(glBindFramebuffer); LG(glFramebufferTexture2D);
  LG(glFramebufferRenderbuffer); LG(glCheckFramebufferStatus); LG(glGenRenderbuffers);
  LG(glBindRenderbuffer); LG(glRenderbufferStorage); LG(glGenTextures); LG(glBindTexture);
  LG(glTexParameteri); LG(glTexImage2D); LG(glGenBuffers); LG(glBindBuffer); LG(glBufferData);
  LG(glEnableVertexAttribArray); LG(glVertexAttribPointer); LG(glViewport); LG(glDrawArrays);
  LG(glFinish); LG(glPixelStorei); LG(glReadPixels); LG(glGetError);
}

static char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *b = malloc(n + 1);
  if (fread(b, 1, n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
  fclose(f);
  b[n] = 0;
  if (len) *len = n;
  return b;
}

static GLuint shader(GLenum kind, const char *src) {
  GLuint s = p_glCreateShader(kind);
  p_glShaderSource(s, 1, &src, NULL);
  p_glCompileShader(s);
  GLint ok = 0;
  p_glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[4096];
    p_glGetShaderInfoLog(s, sizeof log, NULL, log);
    fprintf(stderr, "shader compile failed:\n%s\n", log);
    die("shader compile failed");
  }
  return s;
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static int cmpd(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}
static void st(double *t, int n, double *med, double *p95, double *mn) {
  qsort(t, n, sizeof *t, cmpd);
  *med = t[(n - 1) / 2];
  *p95 = t[(int)((n - 1) * 0.95 + 0.5)];
  *mn = t[0];
}

static uint32_t rd32(const unsigned char *b, size_t o) {
  return b[o] | b[o + 1] << 8 | b[o + 2] << 16 | (uint32_t)b[o + 3] << 24;
}

int main(int argc, char **argv) {
  if (argc < 4) die("usage: gles2bench VS FS PACK [--frames N] [--name K] [--layout L]");
  int frames_req = 60;
  const char *name = "?", *layout = "?";
  for (int i = 4; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--frames")) frames_req = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--name")) name = argv[++i];
    else if (!strcmp(argv[i], "--layout")) layout = argv[++i];
  }
  char *vs = slurp(argv[1], NULL), *fs = slurp(argv[2], NULL);
  size_t plen = 0;
  unsigned char *pk = (unsigned char *)slurp(argv[3], &plen);
  if (!vs || !fs || !pk) die("cannot read shader/pack files");
  if (memcmp(pk, "FXP1", 4)) die("bad pack magic");
  uint32_t W = rd32(pk, 4), H = rd32(pk, 8), N = rd32(pk, 12), A = rd32(pk, 16), U = rd32(pk, 20),
           PF = rd32(pk, 24), K = rd32(pk, 28);
  size_t o = 32;
  uint32_t checks[8];
  for (uint32_t k = 0; k < K && k < 8; k++, o += 4) checks[k] = rd32(pk, o);
  const unsigned char *ledw = pk + o;
  o += 4ull * N * A;
  const unsigned char *frw = pk + o;
  o += 4ull * PF * U;
  const unsigned char *gold = pk + o;
  if (o + 3ull * N * K > plen) die("truncated pack");

  load();
  EGLDisplay d = p_eglGetPlatformDisplayEXT(EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
  EGLint maj = 0, min = 0;
  if (!d || !p_eglInitialize(d, &maj, &min)) die("eglInitialize (surfaceless) failed");
  p_eglBindAPI(EGL_OPENGL_ES_API);
  // Surfaceless exposes no WINDOW configs (EGL's default surface type), so ask
  // for PBUFFER; if none, use EGL_KHR_no_config_context (config = NULL).
  EGLint cattr[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE};
  EGLConfig cfg = NULL;
  EGLint ncfg = 0;
  if (!p_eglChooseConfig(d, cattr, &cfg, 1, &ncfg) || ncfg < 1) cfg = NULL;
  EGLint ctxattr[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  EGLContext ctx = p_eglCreateContext(d, cfg, NULL, ctxattr);
  if (!ctx) die("eglCreateContext failed");
  if (!p_eglMakeCurrent(d, NULL, NULL, ctx)) die("eglMakeCurrent (surfaceless) failed");
  const char *renderer = (const char *)p_glGetString(GL_RENDERER);
  const char *glver = (const char *)p_glGetString(GL_VERSION);
  GLint maxtex = 0, maxvp[2] = {0, 0}, maxattr = 0;
  p_glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxtex);
  p_glGetIntegerv(GL_MAX_VIEWPORT_DIMS, maxvp);
  p_glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &maxattr);
  if ((GLint)W > maxtex || (GLint)H > maxtex) die("layout exceeds GL_MAX_TEXTURE_SIZE");

  GLuint prog = p_glCreateProgram();
  p_glAttachShader(prog, shader(GL_VERTEX_SHADER, vs));
  p_glAttachShader(prog, shader(GL_FRAGMENT_SHADER, fs));
  uint32_t nvec = (A + 3) / 4;
  p_glBindAttribLocation(prog, 0, "a_px");
  for (uint32_t k = 0; k < nvec; k++) {
    char an[16];
    snprintf(an, sizeof an, "a%u", k);
    p_glBindAttribLocation(prog, k + 1, an);
  }
  p_glLinkProgram(prog);
  GLint lok = 0;
  p_glGetProgramiv(prog, GL_LINK_STATUS, &lok);
  if (!lok) {
    char log[4096];
    p_glGetProgramInfoLog(prog, sizeof log, NULL, log);
    fprintf(stderr, "link failed:\n%s\n", log);
    die("program link failed");
  }
  p_glUseProgram(prog);
  GLint *uloc = calloc(U + 1, sizeof *uloc);
  for (uint32_t k = 0; k < U; k++) {
    char un[16];
    snprintf(un, sizeof un, "u%u", k);
    uloc[k] = p_glGetUniformLocation(prog, un);
  }

  // RGBA8 texture FBO, W x H.
  GLuint tex, fbo;
  p_glGenTextures(1, &tex);
  p_glBindTexture(GL_TEXTURE_2D, tex);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  p_glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  p_glGenFramebuffers(1, &fbo);
  p_glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  p_glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
  if (p_glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) die("RGBA8 FBO incomplete");
  p_glViewport(0, 0, W, H);

  // Interleaved vertex data: a_px (NDC of the LED's pixel) + padded inputs.
  uint32_t stride = 2 + 4 * nvec;
  float *vb = calloc((size_t)N * stride, sizeof(float));
  for (uint32_t i = 0; i < N; i++) {
    float *v = vb + (size_t)i * stride;
    v[0] = ((i % W) + 0.5f) / W * 2.0f - 1.0f;
    v[1] = ((i / W) + 0.5f) / H * 2.0f - 1.0f;
    for (uint32_t k = 0; k < A; k++) {
      uint32_t w = rd32(ledw, 4ull * ((size_t)i * A + k));
      memcpy(&v[2 + k], &w, 4);
    }
  }
  GLuint vbo;
  p_glGenBuffers(1, &vbo);
  p_glBindBuffer(GL_ARRAY_BUFFER, vbo);
  p_glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)N * stride * 4, vb, GL_STATIC_DRAW);
  p_glEnableVertexAttribArray(0);
  p_glVertexAttribPointer(0, 2, GL_FLOAT, 0, stride * 4, (void *)0);
  for (uint32_t k = 0; k < nvec; k++) {
    p_glEnableVertexAttribArray(k + 1);
    p_glVertexAttribPointer(k + 1, 4, GL_FLOAT, 0, stride * 4, (void *)(uintptr_t)((2 + 4 * k) * 4));
  }
  p_glPixelStorei(GL_PACK_ALIGNMENT, 1);
  unsigned char *px = malloc((size_t)W * H * 4);

#define SET_UNIFORMS(f)                                                     \
  for (uint32_t k = 0; k < U; k++) {                                        \
    uint32_t w = rd32(frw, 4ull * ((size_t)((f) % PF) * U + k));            \
    float fv;                                                               \
    memcpy(&fv, &w, 4);                                                     \
    if (uloc[k] >= 0) p_glUniform1f(uloc[k], fv);                           \
  }

  // Warm-up (shader compile/upload happens on first draw on many drivers).
  for (int f = 0; f < 5; f++) {
    SET_UNIFORMS(f);
    p_glDrawArrays(GL_POINTS, 0, N);
    p_glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
  }

  int F = frames_req < 3 ? 3 : frames_req;
  double *tr = malloc(F * sizeof(double)), *tb = malloc(F * sizeof(double));
  long max_err = 0, mism = 0, within2 = 0, checked = 0;
  for (int f = 0; f < F; f++) {
    double t0 = now_ms();
    SET_UNIFORMS(f);
    p_glDrawArrays(GL_POINTS, 0, N);
    p_glFinish();
    double t1 = now_ms();
    p_glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
    double t2 = now_ms();
    tr[f] = t1 - t0;
    tb[f] = t2 - t1;
    for (uint32_t k = 0; k < K && k < 8; k++) {
      if ((uint32_t)f != checks[k]) continue;
      const unsigned char *g = gold + 3ull * N * k;
      for (uint32_t i = 0; i < N; i++) {
        long lm = 0;
        for (int c = 0; c < 3; c++) {
          long dd = labs((long)px[4ull * i + c] - (long)g[3ull * i + c]);
          if (dd > lm) lm = dd;
        }
        if (lm > max_err) max_err = lm;
        mism += lm != 0;
        within2 += lm <= 2;
        checked++;
      }
    }
  }
  GLenum err = p_glGetError();
  double rmed, rp95, rmin, bmed, bp95, bmin;
  st(tr, F, &rmed, &rp95, &rmin);
  st(tb, F, &bmed, &bp95, &bmin);

  // Readback-format costs on the already-rendered frame (pure transfer).
  int R = 30;
  double *t = malloc(R * sizeof(double)), rgba_med, x1, x2;
  p_glFinish();
  for (int r = 0; r < R; r++) {
    double a = now_ms();
    p_glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
    t[r] = now_ms() - a;
  }
  st(t, R, &rgba_med, &x1, &x2);
  GLint ifmt = 0, itype = 0;
  p_glGetIntegerv(GL_IMPLEMENTATION_COLOR_READ_FORMAT, &ifmt);
  p_glGetIntegerv(GL_IMPLEMENTATION_COLOR_READ_TYPE, &itype);
  double impl_med = -1;
  if (!(ifmt == GL_RGBA && itype == GL_UNSIGNED_BYTE) && ifmt && itype) {
    for (int r = 0; r < R; r++) {
      double a = now_ms();
      p_glReadPixels(0, 0, W, H, ifmt, itype, px);
      t[r] = now_ms() - a;
    }
    st(t, R, &impl_med, &x1, &x2);
  }
  // RGB565 renderbuffer target: half the bytes (lossy, cost only).
  double r565_med = -1, r565_render = -1;
  {
    GLuint rb, fb2;
    p_glGenRenderbuffers(1, &rb);
    p_glBindRenderbuffer(GL_RENDERBUFFER, rb);
    p_glRenderbufferStorage(GL_RENDERBUFFER, GL_RGB565, W, H);
    p_glGenFramebuffers(1, &fb2);
    p_glBindFramebuffer(GL_FRAMEBUFFER, fb2);
    p_glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb);
    if (p_glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE) {
      double a = now_ms();
      SET_UNIFORMS(0);
      p_glDrawArrays(GL_POINTS, 0, N);
      p_glFinish();
      r565_render = now_ms() - a;
      for (int r = 0; r < R; r++) {
        double b = now_ms();
        p_glReadPixels(0, 0, W, H, GL_RGB, GL_UNSIGNED_SHORT_5_6_5, px);
        t[r] = now_ms() - b;
      }
      st(t, R, &r565_med, &x1, &x2);
    }
    p_glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  }
  // Pipelined: uniforms + draw + readback with no explicit glFinish.
  double pipe_med;
  for (int r = 0; r < R; r++) {
    double a = now_ms();
    SET_UNIFORMS(r);
    p_glDrawArrays(GL_POINTS, 0, N);
    p_glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
    t[r] = now_ms() - a;
  }
  st(t, R, &pipe_med, &x1, &x2);

  printf("{\"bench\":\"gles2\",\"ok\":true,\"kernel\":\"%s\",\"layout\":\"%s\",\"n\":%u,\"w\":%u,\"h\":%u,"
         "\"renderer\":\"%s\",\"gl_version\":\"%s\",\"egl\":\"%d.%d\",\"max_texture\":%d,"
         "\"max_viewport\":[%d,%d],\"max_vertex_attribs\":%d,\"led_inputs\":%u,\"frame_inputs\":%u,"
         "\"frames\":%d,\"render_ms_median\":%.3f,\"render_ms_p95\":%.3f,\"render_ms_min\":%.3f,"
         "\"readback_ms_median\":%.3f,\"readback_ms_p95\":%.3f,\"readback_ms_min\":%.3f,"
         "\"readback_rgba8_only_ms\":%.3f,\"impl_read_format\":\"0x%x/0x%x\",\"readback_impl_ms\":%.3f,"
         "\"rgb565_render_ms\":%.3f,\"readback_rgb565_ms\":%.3f,\"pipelined_ms_median\":%.3f,"
         "\"golden_leds_checked\":%ld,\"golden_max_err\":%ld,\"golden_mismatch_leds\":%ld,"
         "\"golden_within2_leds\":%ld,\"gl_error\":%u}\n",
         name, layout, N, W, H, renderer ? renderer : "?", glver ? glver : "?", maj, min, maxtex,
         maxvp[0], maxvp[1], maxattr, A, U, F, rmed, rp95, rmin, bmed, bp95, bmin, rgba_med, ifmt,
         itype, impl_med, r565_render, r565_med, pipe_med, checked, max_err, mism, within2, err);
  p_eglTerminate(d);
  return 0;
}
