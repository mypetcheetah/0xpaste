'use strict';

// ============================================================
// WebGL Liquid Glass Renderer - 0xpaste overlay
//
// Architecture:
//   - Canvas sits behind panel content (z-index 0)
//   - Outside the lens: fragColor.a = 0 → CSS backdrop-filter shows through
//   - Inside the lens: the screenshot is rendered with lens distortion + lighting
//   - Mouse tracking creates the interactive lens highlight
// ============================================================

const VERT_SRC = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// Shader is the original liquid glass shader, adapted so that:
//   - Outside the lens area the fragment is fully transparent (CSS takes over)
//   - fragColor.a = transition to get a smooth lens edge
const FRAG_SRC = `
  precision mediump float;

  uniform vec3  iResolution;
  uniform float iTime;
  uniform vec4  iMouse;
  uniform sampler2D iChannel0;

  void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    const float POWER_EXPONENT      = 6.0;
    const float MASK_MULTIPLIER_1   = 10000.0;
    const float MASK_MULTIPLIER_2   = 9500.0;
    const float MASK_MULTIPLIER_3   = 11000.0;
    const float LENS_MULTIPLIER     = 5000.0;
    const float MASK_STRENGTH_1     = 8.0;
    const float MASK_STRENGTH_2     = 16.0;
    const float MASK_STRENGTH_3     = 2.0;
    const float MASK_THRESHOLD_1    = 0.95;
    const float MASK_THRESHOLD_2    = 0.9;
    const float MASK_THRESHOLD_3    = 1.5;
    const float SAMPLE_RANGE        = 4.0;
    const float SAMPLE_OFFSET       = 0.5;
    const float GRADIENT_RANGE      = 0.2;
    const float GRADIENT_OFFSET     = 0.1;
    const float LIGHTING_INTENSITY  = 0.3;

    vec2 uv    = fragCoord / iResolution.xy;
    vec2 mouse = iMouse.xy;

    // Default lens position: upper-centre of panel for a nice resting highlight
    if (length(mouse) < 1.0) {
      mouse = iResolution.xy * vec2(0.5, 0.72);
    }

    vec2  m2         = uv - mouse / iResolution.xy;
    float aspect     = iResolution.x / iResolution.y;
    float roundedBox = pow(abs(m2.x * aspect), POWER_EXPONENT)
                     + pow(abs(m2.y),           POWER_EXPONENT);

    float rb1 = clamp((1.0  - roundedBox * MASK_MULTIPLIER_1) * MASK_STRENGTH_1, 0.0, 1.0);
    float rb2 = clamp((MASK_THRESHOLD_1 - roundedBox * MASK_MULTIPLIER_2) * MASK_STRENGTH_2, 0.0, 1.0)
              - clamp((MASK_THRESHOLD_2 - roundedBox * MASK_MULTIPLIER_2) * MASK_STRENGTH_2, 0.0, 1.0);
    float rb3 = clamp((MASK_THRESHOLD_3 - roundedBox * MASK_MULTIPLIER_3) * MASK_STRENGTH_3, 0.0, 1.0)
              - clamp((1.0              - roundedBox * MASK_MULTIPLIER_3) * MASK_STRENGTH_3, 0.0, 1.0);

    float transition = smoothstep(0.0, 1.0, rb1 + rb2);

    if (transition > 0.0) {
      vec2  lens  = ((uv - 0.5) * (1.0 - roundedBox * LENS_MULTIPLIER) + 0.5);
      vec4  col   = vec4(0.0);
      float total = 0.0;

      for (float x = -SAMPLE_RANGE; x <= SAMPLE_RANGE; x++) {
        for (float y = -SAMPLE_RANGE; y <= SAMPLE_RANGE; y++) {
          col   += texture2D(iChannel0, vec2(x, y) * SAMPLE_OFFSET / iResolution.xy + lens);
          total += 1.0;
        }
      }
      col /= total;

      float gradient = clamp((clamp( m2.y, 0.0,      GRADIENT_RANGE) + GRADIENT_OFFSET) / 2.0, 0.0, 1.0)
                     + clamp((clamp(-m2.y, -1000.0,   GRADIENT_RANGE) * rb3 + GRADIENT_OFFSET) / 2.0, 0.0, 1.0);

      vec4 lighting = clamp(col + vec4(rb1) * gradient + vec4(rb2) * LIGHTING_INTENSITY, 0.0, 1.0);

      fragColor   = mix(texture2D(iChannel0, uv), lighting, transition);
      fragColor.a = transition;   // smooth edge; fully transparent outside lens
    } else {
      // Outside lens - transparent so CSS backdrop-filter shows through
      fragColor = vec4(0.0);
    }
  }

  void main() { mainImage(gl_FragColor, gl_FragCoord.xy); }
`;

// ---- Module state ----
let _gl      = null;
let _program = null;
let _uniforms = {};
let _texture = null;
let _rafId   = null;
let _start   = 0;
let _mx = 0, _my = 0;

function _shader(type, src) {
  const s = _gl.createShader(type);
  _gl.shaderSource(s, src);
  _gl.compileShader(s);
  if (!_gl.getShaderParameter(s, _gl.COMPILE_STATUS)) {
    console.error('[glass] shader error:', _gl.getShaderInfoLog(s));
    _gl.deleteShader(s);
    return null;
  }
  return s;
}

function init(canvasEl) {
  _gl = canvasEl.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!_gl) { console.error('[glass] WebGL unavailable'); return false; }

  const vs = _shader(_gl.VERTEX_SHADER,   VERT_SRC);
  const fs = _shader(_gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return false;

  _program = _gl.createProgram();
  _gl.attachShader(_program, vs);
  _gl.attachShader(_program, fs);
  _gl.linkProgram(_program);
  _gl.useProgram(_program);

  const buf = _gl.createBuffer();
  _gl.bindBuffer(_gl.ARRAY_BUFFER, buf);
  _gl.bufferData(_gl.ARRAY_BUFFER,
    new Float32Array([-1,-1,  1,-1,  -1,1,  1,1]), _gl.STATIC_DRAW);

  const pos = _gl.getAttribLocation(_program, 'position');
  _gl.enableVertexAttribArray(pos);
  _gl.vertexAttribPointer(pos, 2, _gl.FLOAT, false, 0, 0);

  _uniforms = {
    resolution: _gl.getUniformLocation(_program, 'iResolution'),
    time:       _gl.getUniformLocation(_program, 'iTime'),
    mouse:      _gl.getUniformLocation(_program, 'iMouse'),
    texture:    _gl.getUniformLocation(_program, 'iChannel0'),
  };

  // Blank 1×1 texture until screenshot arrives
  _texture = _gl.createTexture();
  _gl.bindTexture(_gl.TEXTURE_2D, _texture);
  _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
  _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S,     _gl.CLAMP_TO_EDGE);
  _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T,     _gl.CLAMP_TO_EDGE);
  _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, 1, 1, 0,
    _gl.RGBA, _gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

  _gl.enable(_gl.BLEND);
  _gl.blendFunc(_gl.SRC_ALPHA, _gl.ONE_MINUS_SRC_ALPHA);

  return true;
}

function loadTexture(dataURL) {
  if (!_gl) return;
  const img = new Image();
  img.onload = () => {
    _gl.bindTexture(_gl.TEXTURE_2D, _texture);
    _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, _gl.RGBA, _gl.UNSIGNED_BYTE, img);
  };
  img.src = dataURL;
}

// x, y in canvas CSS pixels (top-left origin)
function setMouse(x, y) {
  const dpr = window.devicePixelRatio || 1;
  _mx = x * dpr;
  _my = _gl ? (_gl.canvas.height - y * dpr) : y * dpr; // flip Y for WebGL
}

function startLoop() {
  if (_rafId) return;
  _start = performance.now();
  const tick = () => {
    if (!_gl || !_program) return;
    const t = (performance.now() - _start) / 1000;
    const w = _gl.canvas.width, h = _gl.canvas.height;
    _gl.viewport(0, 0, w, h);
    _gl.clearColor(0, 0, 0, 0);
    _gl.clear(_gl.COLOR_BUFFER_BIT);
    _gl.uniform3f(_uniforms.resolution, w, h, 1.0);
    _gl.uniform1f(_uniforms.time, t);
    _gl.uniform4f(_uniforms.mouse, _mx, _my, 0, 0);
    _gl.activeTexture(_gl.TEXTURE0);
    _gl.bindTexture(_gl.TEXTURE_2D, _texture);
    _gl.uniform1i(_uniforms.texture, 0);
    _gl.drawArrays(_gl.TRIANGLE_STRIP, 0, 4);
    _rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopLoop() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
}

window.glassRenderer = { init, loadTexture, setMouse, startLoop, stopLoop };
