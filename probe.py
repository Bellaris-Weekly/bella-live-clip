"""B 站直播片段可行性验证；仅 GET 请求，不投稿、不创建草稿。

python3 probe.py --member diana --source history --offset 600 --duration 20
python3 probe.py --member diana --source current --offset 600 --duration 20

启动后隐藏输入 Cookie，凭据只保留在内存。需要本机 ffmpeg / ffprobe。
这是已观测 HLS 格式的验证程序，尚不是正式油猴脚本。
"""

import argparse
import getpass
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


MEMBERS = {
    "bella": (672353429, 22632424),
    "eileen": (672342685, 22625027),
    "diana": (672328094, 22637261),
}
API = "https://api.live.bilibili.com"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://live.bilibili.com/"}


def api_get(path, params, cookie):
    request = Request(API + path + "?" + urlencode(params),
                      headers={**HEADERS, "Cookie": cookie})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result["code"] != 0:
        raise RuntimeError(f"B 站返回 {result['code']}: {result.get('message', '')}")
    return result["data"]


def read_media(url):
    # 媒体 CDN 使用返回的签名地址，绝不携带账号 Cookie。
    with urlopen(Request(url, headers=HEADERS), timeout=30) as response:
        return response.read()


def media_segments(text, base_url):
    """验证当前观测到的独立 m4s 分片清单，避免误处理其他 HLS 表示。"""
    lines = text.splitlines()
    if not lines or lines[0] != "#EXTM3U":
        raise ValueError("返回内容不是 HLS 清单")
    unsupported = ("#EXT-X-KEY:", "#EXT-X-MAP:", "#EXT-X-BYTERANGE:",
                   "#EXT-X-DISCONTINUITY", "#EXT-X-STREAM-INF:")
    if any(line.startswith(unsupported) for line in lines):
        raise ValueError("该清单超出本次验证的独立 m4s 格式范围，需要单独处理")
    segments = [urljoin(base_url, line) for line in lines
                if line and not line.startswith("#")]
    if not segments:
        raise ValueError("清单没有视频分片")
    return segments


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--member", choices=MEMBERS, default="diana")
    parser.add_argument("--source", choices=["history", "current"], default="history")
    parser.add_argument("--offset", type=int, default=600, help="距本场开播的秒数")
    parser.add_argument("--duration", type=int, default=20)
    args = parser.parse_args()
    if args.offset < 0 or args.duration <= 0:
        parser.error("offset 必须非负，duration 必须大于零")
    cookie = getpass.getpass("B 站 Cookie（不回显、不保存）: ").strip()
    uid, room = MEMBERS[args.member]
    if args.source == "history":
        data = api_get("/xlive/web-room/v1/videoService/GetOtherSliceList",
                       {"live_uid": uid, "time_range": 3, "page": 1, "page_size": 30}, cookie)
        records = data["replay_info"] or []
        if not records:
            raise RuntimeError("该账号没有可用的历史回放")
        record = records[0]
        live_key, begin, end = record["live_key"], record["start_time"], record["end_time"]
        title = record["live_info"]["title"]
    else:
        # 公开直播间的 SSR 数据包含准确的 live_id_str，避免 JS 大整数精度损失。
        html = read_media(f"https://live.bilibili.com/{room}").decode()
        marker = "window.__NEPTUNE_IS_MY_WAIFU__="
        ssr = json.JSONDecoder().raw_decode(html.split(marker, 1)[1])[0]
        info = ssr["roomInfoRes"]["data"]["room_info"]
        if info["live_status"] != 1:
            raise RuntimeError("当前未开播；轮播不属于本场直播")
        live_key, begin = info["live_id_str"], info["live_start_time"]
        end, title = int(time.time()), info["title"]
    start, stop = begin + args.offset, begin + args.offset + args.duration
    if stop > end:
        raise ValueError("所选时间超出了本场直播范围")
    data = api_get("/xlive/web-room/v1/videoService/GetUserSliceStream",
                   {"live_uid": uid, "live_key": live_key,
                    "start_time": start, "end_time": stop}, cookie)
    parts = data.get("list") or []
    if not parts:
        raise RuntimeError("这个时间段尚无可用录像")
    folder = Path("output") / f"{args.member}-{args.source}-{time.time_ns()}"
    folder.mkdir(parents=True)
    results = []
    for index, part in enumerate(parts, 1):
        manifest = read_media(part["stream"]).decode()
        segments = media_segments(manifest, part["stream"])
        raw = folder / f"part-{index}.m4s"
        total = 0
        with raw.open("wb") as file:
            for segment in segments:
                chunk = read_media(segment)
                file.write(chunk)
                total += len(chunk)
        target = folder / f"part-{index}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(raw),
                        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
                        "-movflags", "+faststart", str(target)], check=True)
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration,size:stream=codec_name,width,height", "-of", "json", str(target)]))
        results.append({"file": str(target), "segments": len(segments), "downloaded_bytes": total,
                        "returned_range": [part["start_time"], part["end_time"]], "probe": probe})
    summary = {"member": args.member, "source": args.source, "title": title,
               "requested_range": [start, stop], "results": results}
    (folder / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
