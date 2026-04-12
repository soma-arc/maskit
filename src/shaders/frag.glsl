#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_resolution;
uniform vec2  u_offset;    // pan offset in complex coords
uniform float u_scale;     // pixels per unit

void main() {
  // map fragment to complex plane
  vec2 fc = (gl_FragCoord.xy - u_resolution * 0.5) / u_scale + u_offset;
  // placeholder: visualise real/imag as red/green
  fragColor = vec4(fract(fc.x), fract(fc.y), 0.0, 1.0);
}
