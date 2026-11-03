`danmaku.parquet` 是使用 collector 的 `write_archive` / SCHEMA 生成的人工小夹具（无真实用户数据），采用 Zstd、字典和 DELTA_BINARY_PACKED 编码。

- danmaku 分区两行：接收时间 100000 ms 的“测试[花]”，以及缺失 t、sent 为 101000 ms 的顶部固定“置顶”。
- gift 和 sc 分区各一行，用于验证读取弹幕时不会读取其他分区的列数据。
- 端到端测试另以 FFmpeg 临时生成视频与三帧 GIF，验证预演、动图解码、原音频包和取消清理；运行结束删除这些生成文件。
