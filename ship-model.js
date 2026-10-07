"use strict";

// A true 3D counterpart of the first landing page's isometric vessel study.
// Coordinates preserve its swept wings, broad hull plates, and twin engine pods.
(() => {
  const palette = {
    hull: [0.73, 0.74, 0.67, 1],
    armor: [0.79, 0.79, 0.71, 1],
    wing: [0.56, 0.60, 0.52, 1],
    inset: [0.61, 0.65, 0.56, 1],
    pod: [0.66, 0.69, 0.60, 1],
    trim: [0.34, 0.40, 0.32, 1],
    dark: [0.07, 0.10, 0.07, 1],
    glass: [0.29, 0.48, 0.35, 1],
    signal: [0.55, 0.74, 0.52, 1],
    warm: [0.84, 0.65, 0.35, 1],
  };

  function triangulate(plan) {
    const signedArea = plan.reduce((area, point, index) => {
      const next = plan[(index + 1) % plan.length];
      return area + point[0] * next[1] - next[0] * point[1];
    }, 0);
    const order = plan.map((_, index) => index);
    if (signedArea < 0) order.reverse();
    const triangles = [];
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    while (order.length > 3) {
      let found = false;
      for (let i = 0; i < order.length; i += 1) {
        const a = order[(i + order.length - 1) % order.length];
        const b = order[i];
        const c = order[(i + 1) % order.length];
        if (cross(plan[a], plan[b], plan[c]) <= 0.00001) continue;
        const containsPoint = order.some((point) => point !== a && point !== b && point !== c
          && cross(plan[a], plan[b], plan[point]) >= 0
          && cross(plan[b], plan[c], plan[point]) >= 0
          && cross(plan[c], plan[a], plan[point]) >= 0);
        if (containsPoint) continue;
        triangles.push([a, b, c]);
        order.splice(i, 1);
        found = true;
        break;
      }
      if (!found) throw new Error("Invalid vessel panel polygon");
    }
    triangles.push(order);
    return { triangles, clockwise: signedArea < 0 };
  }

  function create() {
    const solid = [];
    const exhaust = [];
    // Interleaved vertex format: position, normal, RGBA, emission (11 floats).
    function face(points, color, emission = 0, target = solid) {
      const a = points[0];
      const b = points[1];
      const c = points[2];
      const u = b.map((value, axis) => value - a[axis]);
      const v = c.map((value, axis) => value - a[axis]);
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...normal);
      if (length < 0.00001) throw new Error("Degenerate vessel face");
      normal.forEach((value, axis) => { normal[axis] = value / length; });
      for (let i = 1; i < points.length - 1; i += 1) {
        [points[0], points[i], points[i + 1]].forEach(([x, y, z]) => {
          target.push(x, y - 35, z + 25, ...normal, ...color, emission);
        });
      }
    }

    function prism(plan, bottom, top, color) {
      const { triangles, clockwise } = triangulate(plan);
      triangles.forEach(([a, b, c]) => {
        face([c, b, a].map((index) => [plan[index][0], top, plan[index][1]]), color);
        face([a, b, c].map((index) => [plan[index][0], bottom, plan[index][1]]), color);
      });
      const outline = clockwise ? [...plan].reverse() : plan;
      outline.forEach(([x, z], index) => {
        const [nextX, nextZ] = outline[(index + 1) % outline.length];
        face([[x, bottom, z], [x, top, z], [nextX, top, nextZ], [nextX, bottom, nextZ]], color);
      });
    }

    function block(x1, x2, z1, z2, bottom, top, color, bevel = 6) {
      prism([
        [x1 + bevel, z1], [x2 - bevel, z1], [x2, z1 + bevel], [x2, z2 - bevel],
        [x2 - bevel, z2], [x1 + bevel, z2], [x1, z2 - bevel], [x1, z1 + bevel],
      ], bottom, top, color);
    }

    function panel(x1, x2, z1, z2, height, color, emission = 0) {
      face([[x1, height, z1], [x1, height, z2], [x2, height, z2], [x2, height, z1]], color, emission);
    }

    function sideWindow(side, x, z1, z2, bottom, top) {
      const rim = [[side * x, bottom, z1], [side * x, top, z1], [side * x, top, z2], [side * x, bottom, z2]];
      const glass = [[side * (x + 0.3), bottom + 3, z1 + 3], [side * (x + 0.3), top - 3, z1 + 3],
        [side * (x + 0.3), top - 3, z2 - 3], [side * (x + 0.3), bottom + 3, z2 - 3]];
      face(side < 0 ? rim.reverse() : rim, palette.dark);
      face(side < 0 ? glass.reverse() : glass, palette.glass, 0.45);
    }

    function nozzle(x) {
      for (let i = 0; i < 8; i += 1) {
        const angle = i * Math.PI / 4;
        const next = (i + 1) * Math.PI / 4;
        const ring = (radius, theta, z) => [x + Math.cos(theta) * radius, 9 + Math.sin(theta) * radius, z];
        face([ring(17, angle, 134), ring(22, angle, 153), ring(22, next, 153), ring(17, next, 134)], palette.trim);
        face([ring(22, angle, 153), ring(13, angle, 153), ring(13, next, 153), ring(22, next, 153)], palette.pod);
        face([[x, 9, 150], ring(12, angle, 153), ring(12, next, 153)], palette.warm, 1.1);
        face([ring(11, angle, 154), [x, 9, 207], ring(11, next, 154)], [0.87, 0.56, 0.23, 0.25], 0.65, exhaust);
      }
    }

    for (const side of [-1, 1]) {
      prism([[side * 44, -118], [side * 249, 53], [side * 261, 113],
        [side * 198, 122], [side * 65, 75], [side * 44, 143]], -19, -3, palette.wing);
      prism([[side * 64, -75], [side * 210, 61], [side * 223, 87], [side * 79, 35]], -2, -1, palette.inset);
      const x = side * 222;
      block(x - 25, x + 25, -27, 137, -13, 32, palette.pod, 9);
      block(x - 20, x + 20, -33, 26, 31, 46, palette.armor, 7);
      panel(x - 14, x + 14, -14, 16, 47, palette.inset);
      block(x - 23, x + 23, 34, 98, 31, 39, palette.hull, 5);
      panel(x - 15, x + 15, 44, 88, 40, palette.inset);
      panel(x - 10, x + 10, 113, 118, 33, palette.signal, 0.45);
      block(side * 162 - 16, side * 162 + 16, 64, 119, -1, 24, palette.pod, 4);
      panel(side * 162 - 10, side * 162 + 10, 76, 98, 25, palette.glass, 0.25);
      nozzle(x);
    }

    block(-53, 53, -204, 157, -10, 44, palette.hull, 13);
    block(-59, 59, -58, 59, 2, 51, palette.hull, 8);
    block(-49, 49, 63, 154, 2, 56, palette.hull, 9);
    block(-43, 43, -200, -78, 42, 83, palette.armor, 10);
    block(-41, 41, -67, 49, 50, 69, palette.armor, 7);
    block(-33, 33, 66, 142, 55, 73, palette.armor, 6);
    for (const [start, end] of [[-64, -29], [-24, 13], [18, 45]]) {
      panel(-34, 34, start, end, 70, palette.inset);
    }
    for (const [start, end] of [[74, 100], [105, 133]]) {
      panel(-27, 27, start, end, 74, palette.inset);
    }
    block(-35, 35, -183, -104, 82, 92, palette.armor, 5);
    panel(-27, 27, -165, -120, 93, palette.inset);
    block(-14, 14, 116, 136, 73, 88, palette.trim, 3);
    panel(-8, 8, 120, 132, 89, palette.glass, 0.25);
    block(-43, -25, 9, 36, 69, 86, palette.pod, 3);
    block(25, 43, 9, 36, 69, 86, palette.pod, 3);
    for (const side of [-1, 1]) {
      for (const [start, end] of [[-179, -151], [-147, -118], [-114, -89]]) {
        sideWindow(side, 43.4, start, end, 54, 76);
      }
      for (const [x, start, end] of [[59.4, -40, -17], [59.4, 10, 33], [49.4, 85, 108]]) {
        sideWindow(side, x, start, end, 20, 36);
      }
    }
    face([[-8, 39, 157.3], [8, 39, 157.3], [8, 47, 157.3], [-8, 47, 157.3]], palette.warm, 0.7);
    return { solid: new Float32Array(solid), exhaust: new Float32Array(exhaust), stride: 11 };
  }

  window.EntropyShipGeometry = Object.freeze({ create });
})();
