// Detects a stick that sits still but not at the centre for a while.
//
// The pad is considered idle only when no button is pressed and the triggers are
// released, so holding a stick in a game (or pressing anything) never triggers
// the hint. A deliberate steady hold near the edge is excluded by the band.
//
// Pure logic, `now` is injected, so it is testable outside the browser.

export const DEFAULTS = {
  restMs: 5000, // how long a stick must stay still
  moveEps: 0.012, // movement above this counts as "in use"
  band: 0.35, // ignore steady holds beyond this magnitude (deliberate deflection)
  holdMs: 180000, // once flagged, keep the hint up this long (calibration needs button presses)
};

export function createDriftWatcher(options = {}) {
  const { restMs, moveEps, band, holdMs } = { ...DEFAULTS, ...options };
  const steadySince = { ls: null, rs: null };
  const previous = { ls: null, rs: null };
  const holdUntil = { ls: 0, rs: 0 };

  function reset(name) {
    steadySince[name] = null;
    previous[name] = null;
    holdUntil[name] = 0;
  }

  return {
    resetAll() {
      reset('ls');
      reset('rs');
    },

    /**
     * @param {{ls:{x:number,y:number}, rs:{x:number,y:number}}} inputs raw axes
     * @param {{idle:boolean, tolerance:number}} context
     * @param {number} now milliseconds
     */
    update(inputs, { idle, tolerance }, now) {
      const result = {};
      for (const name of ['ls', 'rs']) {
        const position = inputs[name];
        const last = previous[name];
        const moved = !last || Math.hypot(position.x - last.x, position.y - last.y) > moveEps;
        if (moved) steadySince[name] = now;
        previous[name] = { x: position.x, y: position.y };

        const magnitude = Math.hypot(position.x, position.y);
        const steadyFor = steadySince[name] === null ? 0 : now - steadySince[name];
        const belowTolerance = magnitude <= tolerance;

        // A stick that came back to centre clears the latch, so the hint only
        // survives while the problem is real (pressing buttons during calibration
        // makes the pad "not idle" for a while, and that must not hide the guide).
        if (belowTolerance) holdUntil[name] = 0;
        const drifting = Boolean(
          idle && steadyFor >= restMs && magnitude <= band && !belowTolerance,
        );
        if (drifting) holdUntil[name] = now + holdMs;

        result[name] = {
          steadyFor,
          magnitude,
          drifting,
          hold: !belowTolerance && now < holdUntil[name],
        };
      }
      return result;
    },
  };
}
