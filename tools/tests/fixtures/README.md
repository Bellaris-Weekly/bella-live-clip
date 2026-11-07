`danmaku.parquet` 是使用 collector 的 `write_archive` / SCHEMA 生成的人工小夹具（无真实用户数据），采用 Zstd、字典和 DELTA_BINARY_PACKED 编码。

- danmaku 分区两行：接收时间 100000 ms 的“测试[花]”，以及缺失 t、sent 为 101000 ms 的顶部固定“置顶”。
- gift 和 sc 分区各一行，用于验证读取弹幕时不会读取其他分区的列数据；audience 分区增加接收时间 200000 ms 的人工心跳，使旧窗口用例处于快照覆盖范围内。
- 端到端测试另以 FFmpeg 临时生成视频与三帧 GIF，验证预演、动图解码、原音频包和取消清理；运行结束删除这些生成文件。

`live-before.parquet` / `live-after.parquet` 同样通过 collector 的 `write_archive` / SCHEMA 生成，使用 `live=1`、房间 1、场次 `growing`、开播时间 95000 ms；全部内容为人工数据。前者包含 `t=100000,110000`，后者包含 `t=100000,110000,120000,130000`，正文为对应时间的数字字符串，`sent=t-500`。用于验证增长快照、封存换路径、左闭右开窗口边界、超时和取消；文件大小不同，直播索引故意使用旧大小以覆盖竞态。

`live-progress-before.parquet` / `live-progress-after.parquet` 同样由 collector 的 `write_archive` 生成（房间 1、场次 `growing`，人工数据），在上面两个文件的基础上加入 collector 2026-11-07 起写入的直播元数据：`complete_through_ms`（前者 112000、后者 131000）、`published_ms`（110500 / 120500）、`publish_interval_ms`（10000），以及 `stream_clock`（一个 epoch，`origin_us=95500000`，600 个分片）。用于验证按完整截止时间判断覆盖、按发布节奏刷新、等待提示和流时钟对时。
