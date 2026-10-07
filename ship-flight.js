"use strict";

// The background vessel is a local WebGL mesh. Render only during a flyby;
// between passes there is no animation loop or GPU drawing work.
(() => {
  const canvas = document.getElementById("ship-flight");
  const monitor = document.getElementById("monitor");
  if (!canvas || !monitor || !window.EntropyShipGeometry) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let renderer = null;
  let unavailable = false;
  let flight = null;
  let frameId = null;
  let waitTimer = null;
  let waitRemaining = 0;
  let waitStarted = null;
  let passes = 0;
  let awake = canvas.dataset.wakeRevealed === "true";
  let metricsDirty = true;

  function multiply(a, b) {
    const result = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        for (let k = 0; k < 4; k += 1) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
      }
    }
    return result;
  }

  function rotationX(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  }

  function rotationY(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  }

  function createRenderer() {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    if (!gl) return null;
    const shaders = [];
    const buffers = [];
    let program = null;
    try {
      const sources = [
        [gl.VERTEX_SHADER, `
          attribute vec3 aPosition;
          attribute vec3 aNormal;
          attribute vec4 aColor;
          attribute float aEmission;
          uniform mat4 uProjection;
          uniform mat4 uModel;
          varying vec3 vNormal;
          varying vec3 vLocalNormal;
          varying vec3 vPosition;
          varying vec4 vColor;
          varying float vEmission;
          void main() {
            gl_Position = uProjection * uModel * vec4(aPosition, 1.0);
            vNormal = mat3(uModel) * aNormal;
            vLocalNormal = aNormal;
            vPosition = aPosition;
            vColor = aColor;
            vEmission = aEmission;
          }
        `],
        [gl.FRAGMENT_SHADER, `
          precision mediump float;
          varying vec3 vNormal;
          varying vec3 vLocalNormal;
          varying vec3 vPosition;
          varying vec4 vColor;
          varying float vEmission;
          uniform float uOpacity;
          uniform float uTime;
          float engineLight(vec3 engine) {
            vec3 offset = (engine - vPosition) / 100.0;
            float distanceSquared = max(dot(offset, offset), 0.01);
            float facing = max(dot(normalize(vLocalNormal), normalize(offset)), 0.0);
            return facing / (1.0 + distanceSquared * 3.0);
          }
          void main() {
            vec3 normal = normalize(vNormal);
            vec3 view = vec3(0.0, 0.0, 1.0);
            vec3 keyDirection = normalize(vec3(-0.45, 0.8, 0.65));
            vec3 rimDirection = normalize(vec3(0.85, 0.2, -0.45));
            float key = max(dot(normal, keyDirection), 0.0);
            float fill = max(dot(normal, normalize(vec3(0.3, -0.6, 0.4))), 0.0);
            float rim = pow(1.0 - abs(dot(normal, view)), 3.0)
              * max(dot(normal, rimDirection), 0.0);
            float specular = pow(max(dot(normal, normalize(keyDirection + view)), 0.0), 48.0);
            float pulse = 0.94 + 0.04 * sin(uTime * 7.0) + 0.02 * sin(uTime * 19.0);
            float spill = engineLight(vec3(-222.0, -26.0, 178.0))
              + engineLight(vec3(222.0, -26.0, 178.0));
            // Local coordinates keep the subtle panel finish attached to the hull.
            float finish = 0.96 + 0.04 * sin(vPosition.x * 1.7 + vPosition.z * 2.3);
            vec3 light = vec3(0.045, 0.055, 0.065)
              + vec3(0.62, 0.78, 0.94) * key
              + vec3(0.035, 0.055, 0.045) * fill
              + vec3(0.95, 0.32, 0.065) * spill * pulse;
            vec3 metal = vColor.rgb * 0.72 * finish * light
              + vec3(0.38, 0.55, 0.70) * specular
              + vec3(0.12, 0.35, 0.42) * rim;
            vec3 emission = vColor.rgb * vEmission * 1.65;
            if (vColor.a < 0.99) emission *= pulse;
            gl_FragColor = vec4(metal + emission, vColor.a * uOpacity);
          }
        `],
      ];
      sources.forEach(([type, source]) => {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Vessel shader compilation failed");
      });
      program = gl.createProgram();
      shaders.forEach((shader) => gl.attachShader(program, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Vessel shader linking failed");
      const geometry = window.EntropyShipGeometry.create();
      const batches = [geometry.solid, geometry.exhaust].map((vertices) => {
        const buffer = gl.createBuffer();
        buffers.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        return { buffer, count: vertices.length / geometry.stride };
      });
      const attributes = [
        [gl.getAttribLocation(program, "aPosition"), 3, 0],
        [gl.getAttribLocation(program, "aNormal"), 3, 12],
        [gl.getAttribLocation(program, "aColor"), 4, 24],
        [gl.getAttribLocation(program, "aEmission"), 1, 40],
      ];
      const projectionUniform = gl.getUniformLocation(program, "uProjection");
      const modelUniform = gl.getUniformLocation(program, "uModel");
      const opacityUniform = gl.getUniformLocation(program, "uOpacity");
      const timeUniform = gl.getUniformLocation(program, "uTime");
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      shaders.forEach((shader) => gl.deleteShader(shader));

      return {
        clear() { gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); },
        draw(model, opacity, width, height, elapsed) {
          const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
          const pixelsWide = Math.round(width * ratio);
          const pixelsHigh = Math.round(height * ratio);
          if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
            canvas.width = pixelsWide;
            canvas.height = pixelsHigh;
          }
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.useProgram(program);
          gl.uniformMatrix4fv(projectionUniform, false, new Float32Array([
            2 / width, 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -1 / 1000, 0, 0, 0, 0, 1,
          ]));
          gl.uniformMatrix4fv(modelUniform, false, model);
          gl.uniform1f(opacityUniform, opacity);
          gl.uniform1f(timeUniform, elapsed / 1000);
          batches.forEach(({ buffer, count }, index) => {
            gl.depthMask(index === 0);
            gl.blendFunc(gl.SRC_ALPHA, index === 0 ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            attributes.forEach(([location, size, offset]) => {
              gl.enableVertexAttribArray(location);
              gl.vertexAttribPointer(location, size, gl.FLOAT, false, geometry.stride * 4, offset);
            });
            gl.drawArrays(gl.TRIANGLES, 0, count);
          });
          gl.depthMask(true);
        },
      };
    } catch {
      shaders.forEach((shader) => gl.deleteShader(shader));
      buffers.forEach((buffer) => gl.deleteBuffer(buffer));
      if (program) gl.deleteProgram(program);
      return null;
    }
  }

  function suspended() {
    return document.hidden || reducedMotion.matches || unavailable;
  }

  function measure() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const rect = monitor.getBoundingClientRect();
    const gap = Math.max(12, flight.bottom ? height - rect.bottom : rect.top);
    // Keep a distant profile in the exposed strip around the giant monitor.
    // On a larger display the same model can pass closer, revealing more detail.
    flight.metrics = { width, height, gap, scale: Math.max(0.18, Math.min(0.66, gap / 115)) };
    metricsDirty = false;
  }

  function schedule() {
    if (!awake || suspended() || flight || waitTimer !== null) return;
    waitStarted = window.performance.now();
    waitTimer = window.setTimeout(begin, waitRemaining);
  }

  function begin() {
    waitTimer = null;
    waitStarted = null;
    if (!awake || suspended() || flight) return;
    if (!renderer) renderer = createRenderer();
    if (!renderer) {
      unavailable = true;
      return;
    }
    flight = {
      duration: 14000 + Math.random() * 4000,
      elapsed: 0,
      lastTick: null,
      lastDraw: -Infinity,
      direction: passes % 2 === 0 ? 1 : -1,
      bottom: passes % 3 === 2,
      reveal: passes === 0,
    };
    passes += 1;
    metricsDirty = true;
    frameId = window.requestAnimationFrame(frame);
  }

  function frame(now) {
    frameId = null;
    if (suspended() || !flight) return;
    if (flight.lastTick !== null) flight.elapsed += now - flight.lastTick;
    flight.lastTick = now;
    const progress = Math.min(1, flight.elapsed / flight.duration);
    if (progress === 1) {
      renderer.clear();
      flight = null;
      waitRemaining = 35000 + Math.random() * 30000;
      schedule();
      return;
    }
    if (now - flight.lastDraw >= 1000 / 30) {
      if (metricsDirty) measure();
      const { width, height, gap, scale } = flight.metrics;
      const forward = flight.direction === 1 ? progress : 1 - progress;
      // The wake-up pass appears at the visible edge with the first typed letters.
      // Later passes retain their full offscreen approach.
      const entry = Math.min(80, width * 0.1);
      const x = flight.reveal ? entry + progress * (width + 200 - entry)
        : -200 + forward * (width + 400);
      const y = (flight.bottom ? height - gap * 0.5 : gap * 0.5) + Math.sin(progress * Math.PI * 2) * gap * 0.08;
      const pitch = 0.16 + Math.sin(progress * Math.PI) * 0.05;
      // Turn slightly toward the viewer to expose the deck and swept wings.
      const yaw = -flight.direction * (Math.PI / 2 - 0.24);
      const model = multiply(rotationX(pitch), rotationY(yaw));
      for (let column = 0; column < 3; column += 1) {
        for (let row = 0; row < 3; row += 1) model[column * 4 + row] *= scale;
      }
      model[12] = x - width / 2;
      model[13] = height / 2 - y;
      model[14] = 0;
      const fadeIn = flight.reveal ? (flight.elapsed + 32) / 200 : progress / 0.08;
      const fade = Math.min(1, fadeIn, (1 - progress) / 0.08);
      renderer.draw(model, fade * 0.92, width, height, flight.elapsed);
      flight.lastDraw = now;
    }
    frameId = window.requestAnimationFrame(frame);
  }

  function pause() {
    if (waitTimer !== null) {
      waitRemaining = Math.max(0, waitRemaining - (window.performance.now() - waitStarted));
      window.clearTimeout(waitTimer);
      waitTimer = null;
      waitStarted = null;
    }
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    frameId = null;
    if (flight) flight.lastTick = null;
  }

  function resume() {
    if (suspended()) return;
    if (flight) {
      if (frameId === null) frameId = window.requestAnimationFrame(frame);
    } else schedule();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else resume();
  });
  canvas.addEventListener("entropy:ship-awake", () => {
    awake = true;
    resume();
  });
  reducedMotion.addEventListener("change", () => {
    pause();
    if (reducedMotion.matches) {
      if (renderer) renderer.clear();
      flight = null;
      waitRemaining = passes === 0 ? 0 : 35000 + Math.random() * 30000;
    } else resume();
  });
  window.addEventListener("resize", () => { metricsDirty = true; });
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    pause();
    renderer = null;
    flight = null;
    unavailable = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    unavailable = false;
    waitRemaining = passes === 0 ? 0 : 35000 + Math.random() * 30000;
    resume();
  });
  schedule();
})();
