import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Where a track plays: "auto" follows the file kind (video → video window,
 * audio → AMP); "amp" plays a video's audio in the AMP with the visualizer.
 */
export type TrackView = "auto" | "amp" | "video";

/** A playable item. `key` identifies it in the queue; `src` is the URL the element plays. */
export interface Track {
  key: string;
  title: string;
  kind: "audio" | "video";
  src: string;
  view: TrackView;
  /** Directory part of the track's path ("" when unknown); the playlist groups by it. */
  folder: string;
}

const folderOf = (path: string | null | undefined): string => {
  const p = path ?? "";
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
};

const AUDIO_EXT = new Set(["m4a", "m4b", "mp3", "opus", "ogg", "oga", "aac", "flac", "wav", "weba", "mka"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "avi", "ts"]);
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXT, ...VIDEO_EXT]);

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const isMediaFile = (name: string): boolean => MEDIA_EXTENSIONS.has(extOf(name));

export const mediaKindFromName = (name: string): "audio" | "video" =>
  AUDIO_EXT.has(extOf(name)) ? "audio" : "video";

/** Extension decides first (output_path, then ext); vcodec only when the extension is unknown. */
export function trackKind(d: { output_path: string | null; vcodec: string | null; ext: string | null }): "audio" | "video" {
  for (const ext of [extOf(d.output_path ?? ""), (d.ext ?? "").toLowerCase()]) {
    if (AUDIO_EXT.has(ext)) return "audio";
    if (VIDEO_EXT.has(ext)) return "video";
  }
  return d.vcodec === "none" ? "audio" : "video";
}

export function streamTrack(d: {
  id: number;
  title: string | null;
  url: string;
  vcodec: string | null;
  ext: string | null;
  output_path: string | null;
}): Track {
  return {
    key: `dl-${d.id}`,
    title: d.title ?? d.url,
    kind: trackKind(d),
    src: `/api/downloads/${d.id}/stream`,
    view: "auto",
    folder: folderOf(d.output_path),
  };
}

export function fileTrack(rel: string, name: string, kind: "audio" | "video"): Track {
  return {
    key: `file-${rel}`,
    title: name,
    kind,
    src: `/api/files/raw?path=${encodeURIComponent(rel)}`,
    view: "auto",
    folder: folderOf(rel),
  };
}

/** A copy of `track` that plays in `view`. */
export const withView = (track: Track, view: TrackView = "auto"): Track => ({ ...track, view });

/** The window a track actually plays in. */
export const effectiveView = (track: Track): "amp" | "video" =>
  track.view === "auto" ? (track.kind === "video" ? "video" : "amp") : track.view;

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 4, 2, 0, -1, 0, 2, 4, 5, 5],
  Pop: [-1, 2, 4, 4, 2, -1, -1, -1, -1, -1],
  Bass: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 2, 4, 6, 7, 7],
  Vocal: [-3, -2, 0, 3, 4, 4, 3, 1, 0, -2],
};

const EQ_KEY = "streamsnap.player.eq.v1";
const VOL_KEY = "streamsnap.player.volume.v1";
const PLAYBACK_KEY = "streamsnap.player.playback.v1";

/** What happens when the last track ends (or "one": the current track loops). */
export type RepeatMode = "off" | "all" | "one";
const REPEAT_CYCLE: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };

/** A shuffled copy of `items` in which the item at `pin` keeps its position (`pin` < 0: nothing pinned). */
function shuffleAround<T>(items: T[], pin: number): T[] {
  const rest = items.filter((_, i) => i !== pin);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (pin >= 0) rest.splice(pin, 0, items[pin]);
  return rest;
}

/** `queue` in the order of `keys`; tracks whose key is not listed keep their queue order at the end. */
function restoreOrder(queue: Track[], keys: string[]): Track[] {
  const pool = new Map<string, Track[]>();
  for (const t of queue) pool.set(t.key, [...(pool.get(t.key) ?? []), t]);
  const out: Track[] = [];
  for (const k of keys) {
    const t = pool.get(k)?.shift();
    if (t) out.push(t);
  }
  const used = new Set(out);
  return [...out, ...queue.filter((t) => !used.has(t))];
}

// Tab handoff: the old tab opens `/?player=1&handoff=<id>`; the new tab posts
// {type:"request", id}; the old tab answers {type:"state", id, snapshot}, then
// stops and empties its queue. No answer within the timeout: nothing changes.
const HANDOFF_CHANNEL = "streamsnap.player.handoff.v1";
const HANDOFF_TIMEOUT_MS = 5000;

interface Snapshot {
  queue: Track[];
  index: number;
  position: number;
  playing: boolean;
  repeat: RepeatMode;
  /** Track keys in their pre-shuffle order; null when shuffle is off. */
  shuffleOrder: string[] | null;
}

type HandoffMessage = { type: "request"; id: string } | { type: "state"; id: string; snapshot: Snapshot };

interface PlayerValue {
  queue: Track[];
  index: number;
  currentTrack: Track | null;
  /** Window holding the media element: the video window for video-view tracks, else the AMP. */
  host: "amp" | "video";
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  eq: number[];
  eqPreset: string;
  vizMode: "bars" | "scope";
  ampOpen: boolean;
  videoOpen: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  playList: (tracks: Track[], start?: number) => void;
  playAt: (index: number) => void;
  /** Append to the queue; never starts playback. */
  addTracks: (tracks: Track[]) => void;
  removeAt: (indexes: number[]) => void;
  moveItem: (from: number, to: number) => void;
  setTrackView: (index: number, view: TrackView) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  setEqBand: (band: number, db: number) => void;
  setEqPreset: (name: string) => void;
  setVizMode: (mode: "bars" | "scope") => void;
  setAmpOpen: (open: boolean) => void;
  setVideoOpen: (open: boolean) => void;
  clearQueue: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  restartList: () => void;
  handoffToNewTab: () => void;
  getAnalyser: () => AnalyserNode | null;
  /** The single media element. It is re-parented between window slots, never unmounted. */
  media: HTMLVideoElement;
}

const PlayerContext = createContext<PlayerValue | null>(null);

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return value;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [media] = useState(() => {
    const el = document.createElement("video");
    el.playsInline = true;
    return el;
  });
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(() => readStored(VOL_KEY, 0.8));
  const [eq, setEq] = useState<number[]>(() => readStored(EQ_KEY, { bands: EQ_PRESETS.Flat, preset: "Flat" }).bands);
  const [eqPreset, setEqPresetName] = useState<string>(() => readStored(EQ_KEY, { bands: EQ_PRESETS.Flat, preset: "Flat" }).preset);
  const [vizMode, setVizMode] = useState<"bars" | "scope">("bars");
  const [ampOpen, setAmpOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);

  const [repeat, setRepeat] = useState<RepeatMode>(() => {
    const stored = readStored<{ repeat?: string }>(PLAYBACK_KEY, {}).repeat;
    return stored === "all" || stored === "one" ? stored : "off";
  });
  // Shuffle is on when this is non-null; it holds the keys in their original order.
  const [shuffleOrder, setShuffleOrder] = useState<string[] | null>(() =>
    readStored<{ shuffle?: boolean }>(PLAYBACK_KEY, {}).shuffle === true ? [] : null,
  );
  const shuffle = shuffleOrder !== null;
  useEffect(() => {
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify({ repeat, shuffle }));
  }, [repeat, shuffle]);

  // The handoff answer runs from a channel callback; it reads the live state here.
  const latest = useRef({ queue, index, repeat, shuffleOrder });
  useEffect(() => {
    latest.current = { queue, index, repeat, shuffleOrder };
  }, [queue, index, repeat, shuffleOrder]);

  // Build the Web Audio graph once, on the first user-started playback:
  // element → 10 peaking EQ bands → analyser → speakers.
  const ensureGraph = useCallback(() => {
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const source = ctx.createMediaElementSource(media);
      const filters = EQ_FREQS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = "peaking";
        f.frequency.value = freq;
        f.Q.value = 1.1;
        f.gain.value = eq[i] ?? 0;
        return f;
      });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      let node: AudioNode = source;
      for (const f of filters) {
        node.connect(f);
        node = f;
      }
      node.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      sourceRef.current = source;
      filtersRef.current = filters;
      analyserRef.current = analyser;
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    // The EQ bands are applied from state; this runs once at graph creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media]);

  /** Show the window the track plays in: the video window for video, else the AMP. */
  const showWindowFor = useCallback((track: Track) => {
    if (effectiveView(track) === "video") setVideoOpen(true);
    else {
      setAmpOpen(true);
      setVideoOpen(false);
    }
  }, []);

  const loadAndPlay = useCallback(
    (track: Track) => {
      ensureGraph();
      showWindowFor(track);
      media.src = track.src;
      void media.play().catch(() => setPlaying(false));
    },
    [media, ensureGraph, showWindowFor],
  );

  const playAt = useCallback(
    (i: number) => {
      const track = queue[i];
      if (!track) return;
      setIndex(i);
      loadAndPlay(track);
    },
    [queue, loadAndPlay],
  );

  const playList = useCallback(
    (tracks: Track[], start = 0) => {
      if (tracks.length === 0) return;
      const track = tracks[start] ?? tracks[0];
      const at = tracks.indexOf(track);
      if (shuffle) setShuffleOrder(tracks.map((t) => t.key));
      setQueue(shuffle ? shuffleAround(tracks, at) : tracks);
      setIndex(at);
      loadAndPlay(track);
    },
    [shuffle, loadAndPlay],
  );

  const addTracks = useCallback(
    (tracks: Track[]) => {
      if (tracks.length === 0) return;
      setQueue((q) => [...q, ...tracks]);
    },
    [],
  );

  const toggle = useCallback(() => {
    if (!media.src && queue[index >= 0 ? index : 0]) {
      playAt(index >= 0 ? index : 0);
      return;
    }
    ensureGraph();
    if (media.paused) void media.play().catch(() => setPlaying(false));
    else media.pause();
  }, [media, queue, index, playAt, ensureGraph]);

  const next = useCallback(() => {
    if (index + 1 < queue.length) playAt(index + 1);
    else if (repeat === "all" && queue.length > 0) playAt(0);
    else {
      media.pause();
      setPlaying(false);
    }
  }, [media, index, queue.length, repeat, playAt]);

  const prev = useCallback(() => {
    if (media.currentTime > 3) {
      media.currentTime = 0;
      return;
    }
    if (index > 0) playAt(index - 1);
  }, [media, index, playAt]);

  const stop = useCallback(() => {
    media.pause();
    media.removeAttribute("src");
    media.load();
    setTime(0);
    setPlaying(false);
  }, [media]);

  const seek = useCallback(
    (seconds: number) => {
      if (Number.isFinite(seconds)) media.currentTime = seconds;
    },
    [media],
  );

  const setVolume = useCallback(
    (value: number) => {
      setVolumeState(value);
      localStorage.setItem(VOL_KEY, JSON.stringify(value));
      media.volume = value;
    },
    [media],
  );

  const applyEq = useCallback((bands: number[], preset: string) => {
    setEq(bands);
    setEqPresetName(preset);
    localStorage.setItem(EQ_KEY, JSON.stringify({ bands, preset }));
    filtersRef.current.forEach((f, i) => {
      f.gain.value = bands[i] ?? 0;
    });
  }, []);

  const setEqBand = useCallback(
    (band: number, db: number) => {
      const next = eq.map((v, i) => (i === band ? db : v));
      applyEq(next, "Custom");
    },
    [eq, applyEq],
  );

  const setEqPreset = useCallback(
    (name: string) => {
      const bands = EQ_PRESETS[name];
      if (bands) applyEq([...bands], name);
    },
    [applyEq],
  );

  const clearQueue = useCallback(() => {
    stop();
    setQueue([]);
    setIndex(-1);
    setShuffleOrder((o) => o && []);
  }, [stop]);

  const cycleRepeat = useCallback(() => setRepeat((r) => REPEAT_CYCLE[r]), []);

  const restartList = useCallback(() => playAt(0), [playAt]);

  // Turning shuffle on keeps the playing track where it is, so playback is not interrupted.
  const toggleShuffle = useCallback(() => {
    if (shuffleOrder) {
      const current = queue[index];
      const restored = restoreOrder(queue, shuffleOrder);
      setQueue(restored);
      if (current) setIndex(restored.indexOf(current));
      setShuffleOrder(null);
    } else {
      setShuffleOrder(queue.map((t) => t.key));
      setQueue(shuffleAround(queue, index));
    }
  }, [queue, index, shuffleOrder]);

  const removeAt = useCallback(
    (indexes: number[]) => {
      const drop = new Set(indexes.filter((i) => i >= 0 && i < queue.length));
      if (drop.size === 0) return;
      const rest = queue.filter((_, i) => !drop.has(i));
      if (rest.length === 0) {
        clearQueue();
        return;
      }
      // Position in `rest` of a surviving old index.
      const shifted = (i: number) => i - [...drop].filter((d) => d < i).length;
      setQueue(rest);
      if (index < 0) return;
      if (!drop.has(index)) {
        setIndex(shifted(index));
        return;
      }
      // The current item went away: play the next survivor, else stop.
      let following = index + 1;
      while (following < queue.length && drop.has(following)) following++;
      if (following < queue.length) {
        const ni = shifted(following);
        setIndex(ni);
        loadAndPlay(rest[ni]);
      } else {
        stop();
        setIndex(-1);
      }
    },
    [queue, index, clearQueue, loadAndPlay, stop],
  );

  const moveItem = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
      const reordered = [...queue];
      const [item] = reordered.splice(from, 1);
      reordered.splice(to, 0, item);
      setQueue(reordered);
      if (index === from) setIndex(to);
      else if (from < index && to >= index) setIndex(index - 1);
      else if (from > index && to <= index) setIndex(index + 1);
    },
    [queue, index],
  );

  const setTrackView = useCallback(
    (i: number, view: TrackView) => {
      const track = queue[i];
      if (!track) return;
      const updated = withView(track, view);
      setQueue(queue.map((t, j) => (j === i ? updated : t)));
      if (i === index) showWindowFor(updated);
    },
    [queue, index, showWindowFor],
  );

  const handoffToNewTab = useCallback(() => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const channel = new BroadcastChannel(HANDOFF_CHANNEL);
    const timer = window.setTimeout(() => channel.close(), HANDOFF_TIMEOUT_MS);
    channel.onmessage = (e: MessageEvent<HandoffMessage>) => {
      if (e.data.type !== "request" || e.data.id !== id) return;
      window.clearTimeout(timer);
      const snapshot: Snapshot = { ...latest.current, position: media.currentTime, playing: !media.paused };
      channel.postMessage({ type: "state", id, snapshot } satisfies HandoffMessage);
      channel.close();
      clearQueue();
    };
    window.open(`/?player=1&handoff=${encodeURIComponent(id)}`, "_blank");
  }, [media, clearQueue]);

  const resume = useCallback(
    (s: Snapshot) => {
      if (s.queue.length === 0) return;
      setQueue(s.queue);
      setIndex(s.index);
      setRepeat(s.repeat);
      setShuffleOrder(s.shuffleOrder);
      const track = s.queue[s.index];
      if (!track) return;
      showWindowFor(track);
      media.src = track.src;
      media.addEventListener(
        "loadedmetadata",
        () => {
          media.currentTime = s.position;
          if (s.playing) void media.play().catch(() => setPlaying(false));
        },
        { once: true },
      );
      // A new tab has no user gesture yet; an AudioContext made now would stay
      // suspended and mute the element. Route through the EQ on the first click.
      window.addEventListener("pointerdown", ensureGraph, { once: true });
    },
    [media, showWindowFor, ensureGraph],
  );

  // Pop-out tab opened by a handoff: ask the old tab for its playback state.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("handoff");
    if (!id) return;
    const channel = new BroadcastChannel(HANDOFF_CHANNEL);
    channel.onmessage = (e: MessageEvent<HandoffMessage>) => {
      if (e.data.type !== "state" || e.data.id !== id) return;
      channel.close();
      const url = new URL(window.location.href);
      url.searchParams.delete("handoff");
      window.history.replaceState(null, "", url);
      resume(e.data.snapshot);
    };
    channel.postMessage({ type: "request", id } satisfies HandoffMessage);
    return () => channel.close();
  }, [resume]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  // Keep the media element in step with stored volume, and wire its events.
  useEffect(() => {
    media.volume = volume;
    const onTime = () => setTime(media.currentTime);
    const onMeta = () => setDuration(Number.isFinite(media.duration) ? media.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      if (repeat === "one") {
        media.currentTime = 0;
        void media.play().catch(() => setPlaying(false));
      } else next();
    };
    media.addEventListener("timeupdate", onTime);
    media.addEventListener("loadedmetadata", onMeta);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", onEnded);
    return () => {
      media.removeEventListener("timeupdate", onTime);
      media.removeEventListener("loadedmetadata", onMeta);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("ended", onEnded);
    };
    // `next` changes with the queue; re-bind so `ended` advances the right track.
  }, [media, next, repeat, volume]);

  const currentTrack = index >= 0 ? queue[index] ?? null : null;

  const value = useMemo<PlayerValue>(
    () => ({
      queue,
      index,
      currentTrack,
      host: currentTrack && effectiveView(currentTrack) === "video" ? "video" : "amp",
      playing,
      time,
      duration,
      volume,
      eq,
      eqPreset,
      vizMode,
      ampOpen,
      videoOpen,
      repeat,
      shuffle,
      playList,
      playAt,
      addTracks,
      removeAt,
      moveItem,
      setTrackView,
      toggle,
      next,
      prev,
      stop,
      seek,
      setVolume,
      setEqBand,
      setEqPreset,
      setVizMode,
      setAmpOpen,
      setVideoOpen,
      clearQueue,
      cycleRepeat,
      toggleShuffle,
      restartList,
      handoffToNewTab,
      getAnalyser,
      media,
    }),
    [
      queue, index, currentTrack, playing, time, duration, volume, eq, eqPreset, vizMode, ampOpen, videoOpen, repeat, shuffle,
      playList, playAt, addTracks, removeAt, moveItem, setTrackView, toggle, next, prev, stop, seek, setVolume,
      setEqBand, setEqPreset, clearQueue, cycleRepeat, toggleShuffle, restartList, handoffToNewTab, getAnalyser, media,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
