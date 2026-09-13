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
  // Time constant for the height it holds, so a one-voxel step in the bed is not a step
  // in the flight.
  heightSmoothing: number;
  // Height above the surface to hold to start from (`Follow.height` is what the flight
  // uses and can be changed while it runs), and how fast to close on it, per second.
  height: number;
  climbRate: number;
  // Voxels a second along the ground, to start from. `Follow.speed` is what the flight
  // actually uses and can be changed while it runs.
  speed: number;
  // How far down to look for the surface, in voxels. Deep enough that a flight that has
  // been raised still sees what it is following.
  probeDepth: number;
}

export const DEFAULT_FOLLOW: FollowOptions = {
  lookahead: 90,
  spread: 0.9,
  arms: 4,
  probes: 3,
  turnRate: 0.55,
  response: 1.1,
  smoothing: 0.7,
  heightSmoothing: 0.9,
  height: 14,
  climbRate: 14,
  speed: 24,
  probeDepth: 200,
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

// Closest the flight will fly to what is under it, and furthest. The floor keeps a
// raise-and-lower from burying the camera in the ground it is following.
export const MIN_HEIGHT = 3;
export const MAX_HEIGHT = 400;

export class Follow {
  readonly options: FollowOptions;
  // Voxels a second along the ground. Public because it is meant to be turned while the
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
    const under = this.surfaceY(state.x, state.y, state.z);
    if (Number.isFinite(under)) {
      this.height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, state.y - under));
    }
    this.rate = 0;
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

  // Height of the first solid voxel under (x, z), or NaN when there is none within reach.
  // NaN rather than a guess: inventing a surface where the probe found nothing is what
  // makes a raised flight climb away from the world, each frame inventing one a little
  // lower than the camera and chasing it upward.
  private surfaceY(x: number, y: number, z: number): number {
    const top = Math.floor(y);
    for (let i = 0; i <= this.options.probeDepth; i++) {
      if (this.at(Math.floor(x), top - i, Math.floor(z)) > 0) return top - i;
    }
    return NaN;
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

    const step = this.speed * dt;
    state.x -= Math.sin(this.yaw) * step;
    state.z -= Math.cos(this.yaw) * step;

    // The height it wants, smoothed before the climb rate is applied to it, so a
    // one-voxel step in the bed does not become a step in the flight.
    const surface = this.surfaceY(state.x, state.y, state.z);
    if (Number.isFinite(surface)) {
      this.hold += (surface + this.height - this.hold) * ease(dt, o.heightSmoothing);
    }
    const rise = o.climbRate * pace * dt;
    const climb = Math.max(-rise, Math.min(rise, this.hold - state.y));
    state.y += climb;

    state.yaw = this.yaw;
    // Look a little down, and further down while descending, eased like everything else
    // so the horizon does not twitch.
    const wantPitch = -0.12 + Math.max(-0.3, Math.min(0.0, (climb / Math.max(dt, 1e-4)) * 0.012));
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
// at 240 Hz, which a plain lerp per frame does not.
function ease(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(tau, 1e-4));
}
