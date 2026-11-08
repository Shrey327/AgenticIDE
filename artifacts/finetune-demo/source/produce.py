"""Narration (local Phonon TTS), timed captions, and final render for the fine-tuning demo.

Steps: `produce.py audio` → `node record.mjs` → `node frames.mjs` → `produce.py render`.
"""
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
TIMELINE = ASSETS / "timeline.json"
STILLROOM = pathlib.Path.home() / "Documents/Stillroom"
PTTS = STILLROOM / ".venv/bin/ptts"
VOICE_MODEL = STILLROOM / ".models/voice-phonon-31m"
VOICE = os.getenv("DEMO_VOICE", "Harper")
OUTPUT = ROOT / "Fine-Tuning-Demo.mp4"
RESULTS = ASSETS / "results.json"
# Dry-run numbers used for first-pass narration timing; replaced by the recorded run's results.json.
DEFAULTS = {"b_exact": 0, "b_fields": 26, "r1_exact": 55, "r1_fields": 87, "r2_exact": 70, "r2_fields": 91, "train1_min": 4,
            "agent_mean": "0.81", "t_tps": 9.0, "v_tps": 42.1, "v_total": 192.2, "t_p50": 3.8, "v_p50": 0.5, "speedup": 2.7}


def numbers():
    values = dict(DEFAULTS)
    if RESULTS.exists():
        r = json.loads(RESULTS.read_text())
        pick = lambda run, key, name: values.__setitem__(name, r[run][key]) if run in r else None
        for run, prefix in [("baseline", "b"), ("round1", "r1"), ("round2", "r2")]:
            pick(run, "exact", prefix + "_exact"); pick(run, "fields", prefix + "_fields")
        pick("round2", "perRequest", "t_tps"); pick("round2", "p50", "t_p50")
        pick("vllm", "perRequest", "v_tps"); pick("vllm", "aggregate", "v_total"); pick("vllm", "p50", "v_p50")
        if "vllm" in r and "round2" in r:
            values["speedup"] = round(r["vllm"]["aggregate"] / r["round2"]["aggregate"], 1)
        for key in ("train1_min", "agent_mean"):
            if key in r:
                values[key] = r[key]
    return values


def spoken(line):
    return line.format(**numbers())


def run(*args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, stdout=subprocess.DEVNULL, **kwargs)


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]))


def stamp(seconds):
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def captions():
    """Write SRT + transcript from the timeline (durations may grow after recording)."""
    scenes = json.loads(TIMELINE.read_text())
    subtitles, transcript, cursor = [], ["# Fine-tuning Qwen3-0.6B for ticket triage in AI Engineering IDE", "", f"Real UI recording of the browser development target; synthetic dataset; local Apple Silicon. Narration: local Phonon TTS ({VOICE}).", ""], 0.0
    for scene in scenes:
        scene["start"] = cursor
        for segment in scene["captions"]:
            subtitles.append(f"{len(subtitles) + 1}\n{stamp(cursor + segment['start'])} --> {stamp(cursor + segment['end'])}\n{segment['text']}\n")
        transcript.extend([f"## {stamp(cursor).split(',')[0]} — {scene['section']}", "", " ".join(spoken(l) for l in scene["lines"]), ""])
        cursor += scene["duration"]
    TIMELINE.write_text(json.dumps(scenes, indent=2))
    (ROOT / "fine-tuning-demo.srt").write_text("\n".join(subtitles))
    (ROOT / "narration.md").write_text("\n".join(transcript))
    return scenes, cursor


if sys.argv[1] == "audio":
    scenes = json.loads((ROOT / "source/scenes.json").read_text())
    ASSETS.mkdir(exist_ok=True)
    # Keep recorded lengths from an earlier recording so re-narrating never truncates video.
    previous = {s["id"]: s.get("recorded", 0) for s in json.loads(TIMELINE.read_text())} if TIMELINE.exists() else {}
    for scene in scenes:
        segments, local = [], 0.7
        for index, line in enumerate(scene["lines"]):
            line = spoken(line)
            audio = ASSETS / f"{scene['id']}-{index}.wav"
            run(PTTS, "-m", VOICE_MODEL, "-l", "en", "-v", VOICE, "-s", "7", "-o", audio, line, env={**os.environ, "HF_HUB_OFFLINE": "1"})
            length = duration(audio)
            assert length > 0.3, f"Speech synthesis produced empty audio: {audio}"
            segments.append({"text": line, "start": local, "end": local + length, "file": audio.name})
            local += length + 0.35
        scene["recorded"] = previous.get(scene["id"], 0)
        scene["duration"] = round(max(local + 0.8, scene["recorded"]), 3)
        scene["captions"] = segments
        inputs, parts = [], []
        for index, segment in enumerate(segments):
            inputs.extend(["-i", ASSETS / segment["file"]])
            parts.append(f"[{index}:a]aresample=48000,adelay={round(segment['start'] * 1000)}:all=1[a{index}]")
        parts.append("".join(f"[a{i}]" for i in range(len(segments))) + f"amix=inputs={len(segments)}:normalize=0[audio]")
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(parts), "-map", "[audio]", "-ac", "1", ASSETS / f"{scene['id']}.wav")
        print(scene["id"], scene["duration"], flush=True)
    TIMELINE.write_text(json.dumps(scenes, indent=2))
    print(f"Total narration: {captions()[1]:.1f} seconds", flush=True)

elif sys.argv[1] == "fit":
    # Fast-forward recorded UI clips that run longer than their narration (shown with a badge), max 3x.
    scenes = json.loads(TIMELINE.read_text())
    for scene in scenes:
        narration = scene["captions"][-1]["end"] + 0.8
        recorded = scene.get("recorded", 0)
        target = narration + 1.0
        scene["speed"] = round(min(3.0, recorded / target), 2) if recorded > target + 1 else 1.0
        scene["duration"] = round(max(narration, recorded / scene["speed"]), 3)
        print(scene["id"], scene["speed"], scene["duration"], flush=True)
    TIMELINE.write_text(json.dumps(scenes, indent=2))
    print(f"Total: {sum(s['duration'] for s in scenes):.1f} seconds")

elif sys.argv[1] == "render":
    scenes, total = captions()
    for scene in scenes:
        name, length = scene["id"], scene["duration"]
        movie = ASSETS / f"{name}.webm"
        common = ["-i", ASSETS / f"{name}.wav"]
        if movie.exists():
            # UI recording inset into the 1920x1080 caption frame.
            args = ["-f", "concat", "-safe", "0", "-i", ASSETS / f"{name}-frames.txt", "-i", movie, *common,
                    "-filter_complex", f"[0:v]fps=30,format=yuv420p[frame];[1:v]setpts=PTS/{scene.get('speed', 1.0)},scale=1440:900,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration={length}[ui];[frame][ui]overlay=420:90:shortest=1,format=yuv420p[out];[2:a]apad[a]",
                    "-map", "[out]", "-map", "[a]"]
        else:
            args = ["-f", "concat", "-safe", "0", "-i", ASSETS / f"{name}-frames.txt", *common,
                    "-filter_complex", "[0:v]fps=30,format=yuv420p[out];[1:a]apad[a]", "-map", "[out]", "-map", "[a]"]
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, "-t", length, "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", ASSETS / f"{name}-final.mp4")
        print("Rendered", name, flush=True)
    listing = ASSETS / "final-concat.txt"
    listing.write_text("\n".join(f"file '{s['id']}-final.mp4'" for s in scenes))
    metadata = [";FFMETADATA1", "title=Fine-tuning Qwen3-0.6B for ticket triage in AI Engineering IDE", "comment=Real UI recording; synthetic dataset; local Apple Silicon LoRA training, vLLM serving, Codex agent review; Phonon TTS narration."]
    for scene in scenes:
        metadata.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(scene['start'] * 1000)}", f"END={round((scene['start'] + scene['duration']) * 1000)}", "title=" + scene["section"]])
    (ASSETS / "chapters.txt").write_text("\n".join(metadata))
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-i", ASSETS / "chapters.txt", "-i", ROOT / "fine-tuning-demo.srt",
        "-map", "0:v", "-map", "0:a", "-map", "2:s", "-map_metadata", "1", "-map_chapters", "1", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-movflags", "+faststart", OUTPUT)
    print("Final", round(duration(OUTPUT), 1), "s", flush=True)
