"""Build local narration, timed captions, and the final narrated demo."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SCENES = json.loads((ROOT / "source/scenes.json").read_text())


def run(*args):
    subprocess.run([str(x) for x in args], check=True, stdout=subprocess.DEVNULL)


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]))


def stamp(seconds):
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


if sys.argv[1] == "audio":
    subtitles, cursor, number = [], 0.0, 1
    transcript = ["# AI Engineering IDE — workflow demo", "", "Real UI recording. Deterministic retrieval example and real CPU PyTorch training. Model/RAG sections are configuration tours. Narration uses macOS Daniel speech synthesis.", ""]
    for scene in SCENES:
        scene["start"] = cursor
        segments, local = [], 0.7
        for index, line in enumerate(scene["lines"]):
            audio = ASSETS / f"{scene['id']}-{index}.aiff"
            run("say", "-v", "Daniel", "-r", "163", "-o", audio, line)
            length = duration(audio)
            assert length > 0.3, f"Speech synthesis produced empty audio: {audio}"
            segments.append({"text": line, "start": local, "end": local + length, "file": audio.name})
            subtitles.append(f"{number}\n{stamp(cursor+local)} --> {stamp(cursor+local+length)}\n{line}\n")
            number += 1
            local += length + 0.3
        scene["duration"] = round(local + 0.8, 3)
        scene["captions"] = segments
        inputs, parts = [], []
        for index, segment in enumerate(segments):
            inputs.extend(["-i", ASSETS / segment["file"]])
            delay = round(segment["start"] * 1000)
            parts.append(f"[{index}:a]aresample=48000,adelay={delay}:all=1[a{index}]")
        parts.append("".join(f"[a{i}]" for i in range(len(segments))) + f"amix=inputs={len(segments)}:normalize=0,apad=whole_dur={scene['duration']}[audio]")
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(parts), "-map", "[audio]", "-t", scene["duration"], "-ac", "1", ASSETS / f"{scene['id']}.wav")
        transcript.extend([f"## {stamp(cursor).split(',')[0]} — {scene['section']}", "", " ".join(scene["lines"]), ""])
        cursor += scene["duration"]
        print(scene["id"], scene["duration"], flush=True)
    (ASSETS / "timeline.json").write_text(json.dumps(SCENES, indent=2))
    (ROOT / "workflow-demo.srt").write_text("\n".join(subtitles))
    (ROOT / "narration.md").write_text("\n".join(transcript))
    print(f"Total: {cursor:.1f} seconds", flush=True)

elif sys.argv[1] == "render":
    scenes = json.loads((ASSETS / "timeline.json").read_text())
    for scene in scenes:
        name = scene["id"]
        movie = ASSETS / f"{name}.webm"
        if movie.exists():
            source = ["-i", movie]
        else:
            still = "overview.png" if name == "01-intro" else "06-improve.png"
            source = ["-loop", "1", "-framerate", "30", "-i", ASSETS / still]
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", ASSETS / f"{name}-frames.txt", *source, "-i", ASSETS / f"{name}.wav", "-filter_complex", f"[0:v]fps=30,format=yuv420p[frame];[1:v]scale=1440:900,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration={scene['duration']}[ui];[frame][ui]overlay=420:90:shortest=1,format=yuv420p[out]", "-map", "[out]", "-map", "2:a", "-t", scene["duration"], "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", ASSETS / f"{name}-final.mp4")
        print("Rendered", name, flush=True)
    listing = ASSETS / "final-concat.txt"
    listing.write_text("\n".join(f"file '{s['id']}-final.mp4'" for s in scenes))
    metadata = [";FFMETADATA1", "title=AI Engineering IDE | An AI engineer's workflow", "comment=Real UI recording; deterministic retrieval example; CPU PyTorch training; model and RAG configuration tours."]
    for scene in scenes:
        start = round(scene["start"] * 1000)
        end = round((scene["start"] + scene["duration"]) * 1000)
        metadata.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}", "title=" + scene["section"]])
    (ASSETS / "chapters.txt").write_text("\n".join(metadata))
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-i", ASSETS / "chapters.txt", "-i", ROOT / "workflow-demo.srt", "-map", "0:v", "-map", "0:a", "-map", "2:s", "-map_metadata", "1", "-map_chapters", "1", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-movflags", "+faststart", ROOT / "AI-Engineering-IDE-Workflow-Demo.mp4")
    print("Final", duration(ROOT / "AI-Engineering-IDE-Workflow-Demo.mp4"), flush=True)
