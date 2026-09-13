// A flyover that follows what is under it. Start it over a stream and it flies down the
// stream; start it over the canopy and it follows the wood.
//
// The rule is one sentence: keep going the way you were pointed, and of the headings
// near that one, prefer the one with the most of the material you started over. That is
// enough to follow a river, because a river is the only thing shaped like a river.
//
// Pure apart from the voxel lookup it is handed, so it can be tested without a GPU or a
// browser. The caller supplies `blockAt`, which returns a block id or -1 where the world
// is not resident; not-resident is treated as "no match", so the flight straightens out
// rather than turning into ground it cannot see.

export interface FollowOptions {
  // How far ahead the candidate headings are sampled, in voxels. About a second of
  // travel reads as anticipating a bend rather than reacting to one.
  lookahead: number;
  // Half the fan of headings considered, in radians, and how many to each side.
  spread: number;
  arms: number;
  // Samples along each arm. One point per arm makes each arm's score a yes or no, and a
  // boolean that flips as the flight moves is a heading that weaves; several points make
  // it a coverage fraction that slides.
  probes: number;
  // Radians per second the heading may change. The limit is what stops it snapping onto
  // a tributary the moment one comes into range.
  turnRate: number;
  // Seconds to close on the heading it wants, and the time constant the turn rate itself
  // is smoothed over. The second one is what bounds the *change* in turn rate, so the
  // camera eases into a bend instead of hinging into it.
  response: number;
  smoothing: number;
  // Time constants for the height it holds, so a one-voxel step in the bed is not a step
  // in the flight. Coming down is slow and going up is quick: rising is the move that
  // cannot end inside a hill, so when the two disagree the flight lifts.
  heightSmoothing: number;
  riseSmoothing: number;
  // Seconds to close the gap to the height it holds, and the time constant the vertical
  // rate itself is eased over. The second is to the climb what `smoothing` is to the
  // turn: it bounds the *change* in rate, so the flight leans into a lift.
  liftResponse: number;
  liftSmoothing: number;
  // Height above the surface to hold to start from (`Follow.height` is what the flight
  // uses and can be changed while it runs), and how fast to close on it, per second.
  height: number;
  climbRate: number;
  // Voxels a second through the air, to start from. Through the air rather than along
  // the ground: a climb is spent out of the same budget as the forward step, so the
  // camera moves at one rate whether it is crossing a flat or lifting over a ridge.
  // `Follow.speed` is what the flight actually uses and can be changed while it runs.
  speed: number;
  // How far down to look for the surface, in voxels. It has to cover `MAX_HEIGHT`, or a
  // flight raised past it stops finding the ground: the fan then matches nothing and
  // holds its heading, and the height probe returns NaN so the flight stops following
  // the ground it was following. Depth costs nothing where there *is* ground, because
  // the scan stops at the first solid voxel; only the empty case pays.
  probeDepth: number;
  // How far above the camera the clearance probe starts. Anything taller than the flight
  // by less than this reads as an obstacle; anything taller than this reads as ground the
  // flight is already inside, which is what the hard floor is for.
  clearAbove: number;
  // How far ahead the corridor is swept, and how many samples along it. Much further
  // than `lookahead`, which is about which way to go: this is about how high to be, and a
  // flight that first sees a mountain at the distance it picks a bend at has no room to
  // climb it and has to jump. One per arm would be a fan; this is one line, the one it
  // will fly.
  clearLookahead: number;
  clearProbes: number;
}

// Closest the flight will fly to what is under it, and furthest. The floor keeps a
// raise-and-lower from burying the camera in the ground it is following, and it is also
// the air the flight keeps over anything in its way: the two are the same number so that
// lowering the flight as far as it goes and clearing an obstacle agree about what
// "just over it" means.
export const MIN_HEIGHT = 3;
export const MAX_HEIGHT = 400;

export const DEFAULT_FOLLOW: FollowOptions = {
  lookahead: 90,
  spread: 0.9,
  arms: 4,
  probes: 3,
  turnRate: 0.55,
  response: 1.1,
  smoothing: 0.7,
  heightSmoothing: 0.9,
  riseSmoothing: 0.25,
  liftResponse: 0.9,
  liftSmoothing: 0.45,
  height: 14,
  climbRate: 14,
  speed: 24,
  probeDepth: MAX_HEIGHT + 40,
  clearAbove: 140,
  clearLookahead: 280,
  clearProbes: 8,
};

// Where the camera should be and be looking, filled in place so the frame path allocates
// nothing.
export interface FollowState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export type BlockAt = (x: number, y: number, z: number) => number;


// Most the climb rate may be multiplied by when the flight is far below the height it
// wants. It is a multiplier and not a second rate so that the response is continuous in
// the gap: a threshold here would be a visible kick at whatever height it sat.
const MAX_URGENCY = 4;

// The slope the flight plans its lifts on: an obstacle `d` voxels ahead is asked for its
// clearance less `d * CLIMB_SLOPE`, so the demand arrives as a ramp rather than a step.
// Shallow enough that a lift starts long before the thing that caused it.
const CLIMB_SLOPE = 0.5;

// Inside this distance an obstacle is asked for its whole clearance, with no slope
// discount: there is no room left to climb, so anything less is a demand the flight
// cannot answer in time and then has to be snapped up to.
const CLEAR_HARD = 90;

export class Follow {
  readonly options: FollowOptions;
  // Voxels a second through the air. Public because it is meant to be turned while the
  // flight runs: the same keys that change the fly speed change this. Everything that
  // depends on the speed is derived from it rather than fixed, or a fast flight overshoots
  // every bend it meets.
  speed: number;
  // How far over the surface it flies. Public for the same reason as the speed: the keys
  // that fly up and down move this while the flight runs, so raising the camera raises
  // the whole flight rather than being pulled straight back down.
  height: number;
  // The block the flight is following, taken from under the camera when it starts.
  target = 0;
  // What the last probe found, for the overlay: how many of the fan's arms matched.
  matched = 0;

  private readonly at: BlockAt;
  private yaw = 0;
  // The smoothed state: everything the flight does is a low-pass away from a target, so
  // nothing in the pose changes faster than these let it.
  private rate = 0; // radians a second, signed
  private hold = 0; // the height it is flying to
  private pitch = 0;
  // What the last clearance probe found: how high the flight has to be here to clear
  // what is ahead of it, and the top of the column the camera is over. -Infinity and NaN
  // for nothing.
  private need = -Infinity;
  private here = NaN;
  private lift = 0; // voxels a second, signed: the vertical rate, eased like the turn
  private vertical = 0; // voxels a second, signed and smoothed again, for the pitch

  constructor(blockAt: BlockAt, options: FollowOptions = DEFAULT_FOLLOW) {
    this.at = blockAt;
    this.options = options;
    this.speed = options.speed;
    this.height = options.height;
  }

  // How far ahead this flight looks, and how hard it is willing to turn. Both scale with
  // the speed: the lookahead so a bend is seen the same number of *seconds* out however
  // fast the camera is going, and the turn rate because a wider turn at the same rate is
  // a wider arc, which at speed swings the flight off the water it is following. Clamped
  // at both ends so a crawl still looks somewhere and a sprint does not pivot.
  private get pace(): number {
    return Math.max(0.35, Math.min(3.0, this.speed / this.options.speed));
  }

  // Picks up the material under `state` and starts from the heading it already has.
  // Returns the block it will follow, 0 when there is nothing under the camera at all.
  start(state: FollowState): number {
    this.yaw = state.yaw;
    // Start from where the camera already is, so turning it on does not yank the view
    // to some other height first.
    // Started under the ground (a camera inside a hill, a spawn that has drifted below
    // the surface), the difference is negative and clamping it would pin the flight to
    // the floor for the rest of the run. Fall back to the option's own height instead.
    const under = this.surfaceY(state.x, state.y + this.options.clearAbove, state.z, this.options.probeDepth + this.options.clearAbove);
    const over = Number.isFinite(under) ? state.y - under : NaN;
    this.height = over > MIN_HEIGHT ? Math.min(MAX_HEIGHT, over) : this.options.height;
    // Every smoothed term, or a flight switched off and on again carries the last one's
    // rates into the new one and starts with a turn and a climb it never asked for.
    this.rate = 0;
    this.lift = 0;
    this.vertical = 0;
    this.hold = state.y;
    this.pitch = state.pitch;
    this.target = this.surfaceBlock(state.x, state.y, state.z);
    return this.target;
  }

  // The height of the first solid voxel under (x, z) at or below y, and the block there.
  // Returns -1 for a column that is not resident or is empty all the way down.
  private surfaceBlock(x: number, y: number, z: number): number {
    const top = Math.floor(y);
    for (let i = 0; i <= this.options.probeDepth; i++) {
      const b = this.at(Math.floor(x), top - i, Math.floor(z));
      if (b > 0) return b;
    }
    return 0;
  }

  // Height of the first solid voxel at or under (x, y, z), or NaN when there is none
  // within `depth`. NaN rather than a guess: inventing a surface where the probe found
  // nothing is what makes a raised flight climb away from the world, each frame inventing
  // one a little lower than the camera and chasing it upward.
  private surfaceY(x: number, y: number, z: number, depth = this.options.probeDepth): number {
    const top = Math.floor(y);
    for (let i = 0; i <= depth; i++) {
      if (this.at(Math.floor(x), top - i, Math.floor(z)) > 0) return top - i;
    }
    return NaN;
  }

  // How high the flight has to be *here* to clear what is ahead, written into `need`,
  // and the top of the column it is over, written into `here`. Neither is returned, so
  // the frame path allocates nothing.
  //
  // Two things make this smooth rather than a series of steps. The probe starts
  // `clearAbove` over the camera, because a probe that starts at the camera finds the
  // floor of a cliff rather than its rim and the flight then aims at the rock. And each
  // probe asks for clearance on a glide slope rather than at full height: an obstacle
  // `d` ahead only needs `d * CLIMB_SLOPE` less of it, so as it comes closer the demand
  // rises continuously instead of appearing whole the moment a probe crosses its edge.
  // That step was what the flight read as a jolt, and no amount of smoothing after the
  // fact removes a step; it has to not be there.
  private clearance(x: number, y: number, z: number, pace: number): void {
    const o = this.options;
    const from = y + o.clearAbove;
    const depth = o.probeDepth + o.clearAbove;
    this.here = this.surfaceY(x, from, z, depth);
    this.need = Number.isFinite(this.here) ? this.here + MIN_HEIGHT : -Infinity;
    for (let k = 1; k <= o.clearProbes; k++) {
      // Squared spacing, so the probes crowd the camera and thin out with distance: the
      // demand a probe makes is discounted by its own distance, so a coarse probe far
      // out costs nothing but a coarse probe close in leaves a step exactly where the
      // flight has no room left to answer it.
      const t = k / o.clearProbes;
      const d = o.clearLookahead * pace * t * t;
      const h = this.surfaceY(x - Math.sin(this.yaw) * d, from, z - Math.cos(this.yaw) * d, depth);
      // Full clearance for anything inside `CLEAR_HARD`, and the glide slope beyond it.
      // Without the flat part the demand is still short of the obstacle at the last
      // probe before it, by exactly that probe's own discount, and the flight arrives
      // low and has to be snapped up.
      const want = h + MIN_HEIGHT - Math.max(0, d - CLEAR_HARD) * CLIMB_SLOPE;
      if (want > this.need) this.need = want;
    }
  }

  // Advances the flight by `dt` seconds, writing the new pose into `state`.
  step(state: FollowState, dt: number): void {
    const o = this.options;
    // The caller's heading wins, so dragging the view while the flight runs re-aims it
    // rather than fighting it.
    this.yaw = state.yaw;
    // Where the fan says to go, as a weighted mean of its arms rather than the best of
    // them. Picking the best arm makes the wanted heading jump by a whole arm the moment
    // one arm's score passes another's, and the flight weaves between them; the mean
    // slides, and a bend comes on gradually because the arms on that side gain together.
    let sum = 0;
    let weighted = 0;
    const pace = this.pace;
    this.matched = 0;
    for (let i = -o.arms; i <= o.arms; i++) {
      const off = (i / o.arms) * o.spread;
      const yaw = this.yaw + off;
      let hits = 0;
      for (let k = 1; k <= o.probes; k++) {
        const d = (o.lookahead * pace * k) / o.probes;
        if (this.surfaceBlock(state.x - Math.sin(yaw) * d, state.y, state.z - Math.cos(yaw) * d) === this.target) {
          hits++;
        }
      }
      if (hits > 0) this.matched++;
      // Straight ahead is worth something on its own, so a fan with nothing in it holds
      // the line rather than drifting to whichever edge rounded up.
      const score = hits / o.probes + 0.35 * (1 - Math.abs(off) / o.spread);
      const w = score * score; // squared, so the arms that match lead without the rest being ignored
      sum += w;
      weighted += w * off;
    }
    const want = sum > 0 ? weighted / sum : 0;

    // Turn by easing the *rate*, not the heading. A rate that is itself low-passed bounds
    // how fast the turn can tighten, which is the difference between banking into a bend
    // and hinging into it.
    const limit = o.turnRate * pace;
    const wantRate = Math.max(-limit, Math.min(limit, want / o.response));
    this.rate += (wantRate - this.rate) * ease(dt, o.smoothing);
    this.yaw += this.rate * dt;

    // The frame's whole travel budget, in voxels. What is spent lifting is not spent
    // going forward, so the camera moves at one rate over a flat and over a ridge: a
    // climb that added to the forward step would read as the flight speeding up exactly
    // where it is working hardest.
    const budget = this.speed * dt;
    const ax = state.x - Math.sin(this.yaw) * budget;
    const az = state.z - Math.cos(this.yaw) * budget;

    // Nothing the flight is about to cross may end up above it. The corridor is measured
    // from over the camera and the height it wants is never less than clearance over the
    // highest thing in it.
    this.clearance(ax, state.y, az, pace);
    const surface = this.surfaceY(ax, state.y, az);
    let wantY = Number.isFinite(surface) ? surface + this.height : this.hold;
    if (this.need > -Infinity) wantY = Math.max(wantY, this.need);
    // Asymmetric on purpose: it settles down over its own long time constant and lifts
    // over a short one, so ground coming up is cleared rather than met.
    this.hold += (wantY - this.hold) * ease(dt, wantY > this.hold ? o.riseSmoothing : o.heightSmoothing);


    // The vertical rate, eased rather than set, for the same reason the turn rate is: what
    // the eye reads as a jolt is the change in a rate, not the rate. Going up the cap
    // grows with the gap, because a rate fixed at a walking pace cannot clear a
    // hundred-voxel wall inside the corridor that saw it, and what does not clear a wall
    // ends up inside it. Neither direction may exceed the travel budget in a frame, which
    // is what keeps the camera moving at one speed: a steep lift spends the budget on the
    // lift and stops going forward.
    const gap = this.hold - state.y;
    const urgency = gap > 0 ? Math.min(MAX_URGENCY, 1 + gap / o.climbRate) : 1;
    const up = Math.min(o.climbRate * pace * urgency, this.speed);
    const down = Math.min(o.climbRate * pace, this.speed);
    const wantLift = Math.max(-down, Math.min(up, gap / o.liftResponse));
    this.lift += (wantLift - this.lift) * ease(dt, o.liftSmoothing);
    let climb = Math.max(-budget, Math.min(budget, this.lift * dt));
    // The last resort, for ground that appeared inside the corridor rather than at the
    // end of it (a chunk that has just streamed in, a cliff met at speed). The eased
    // climb above is what normally clears an obstacle; this only ever moves up, and only
    // as far as the air the flight is owed over the column it is actually in.
    const floor = this.here + MIN_HEIGHT - state.y;
    if (Number.isFinite(this.here) && floor > climb) {
      climb = floor;
      // Carry the escape into the eased rate so the next frame does not pull straight
      // back down, but no further than the rate it was allowed anyway: the raw
      // `climb / dt` of a one-frame lift is hundreds of voxels a second, and easing down
      // from that climbs at full speed for half a second after the obstacle is cleared.
      this.lift = Math.min(climb / Math.max(dt, 1e-4), up);
    }
    state.y += climb;

    // What is left of the budget after the climb. A wall stops the flight dead and lifts
    // it, which is the only way out that does not go through the wall.
    const forward = Math.sqrt(Math.max(0, budget * budget - climb * climb));
    state.x -= Math.sin(this.yaw) * forward;
    state.z -= Math.cos(this.yaw) * forward;

    state.yaw = this.yaw;
    // Look a little down, and further down while descending. The vertical rate is
    // low-passed before the pitch is taken from it and the pitch is eased again after:
    // one frame's climb is a noisy number (the probe under the camera steps by whole
    // voxels, and the last-resort lift is a spike), and a pitch taken straight off it
    // twitches however gently it is then eased.
    this.vertical += (climb / Math.max(dt, 1e-4) - this.vertical) * ease(dt, o.smoothing);
    const wantPitch = -0.12 + Math.max(-0.3, Math.min(0.0, this.vertical * 0.012));
    this.pitch += (wantPitch - this.pitch) * ease(dt, o.smoothing);
    state.pitch = this.pitch;
  }
}

// Moves the held height, for the keys that raise and lower the flight. `by` is voxels.
export function raiseHeight(height: number, by: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height + by));
}

// Fraction of the way to close on a target in `dt` seconds with time constant `tau`.
// Frame-rate independent: the same second of flight lands in the same place at 30 Hz and
// at 240 Hz, which a plain lerp per frame does not. Exported because everything that
// moves a camera smoothly wants exactly this and there should be one of it.
export function ease(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(tau, 1e-4));
}
