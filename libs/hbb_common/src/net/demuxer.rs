// hbb_common/src/net/demuxer.rs
// 🌟 零成本抽象：基于单字节非对齐读取与模式匹配的强类型协议多路解复用器

use bytes::BytesMut;

/// 定义清晰的协议包分类，消灭魔术数字和大小过滤坏味道
#[derive(Debug)]
pub enum ClassifiedPacket {
    /// KCP 原始控制包 (ACK/SACK/Ping 等)，cmd != 81，纯物理网络包，无需解密和 framed 解包
    KcpControl(BytesMut),
    /// 真正的音视频加密数据载荷，cmd == 81，需要走完整的解密与重组流
    EncryptedPayload(BytesMut),
    /// 畸形包，数据长度小于 KCP 基础头部 24 字节
    Malformed,
}

pub struct ProtocolDemuxer;

impl ProtocolDemuxer {
    /// 🚀 亚微秒级零拷贝包分类器
    #[inline(always)]
    pub fn demux(buf: BytesMut) -> ClassifiedPacket {
        // KCP 基础头部刚性限制为 24 字节
        if buf.len() < 24 {
            return ClassifiedPacket::Malformed;
        }

        // KCP 24B 头部中，Byte 4 为 cmd 指令字
        let kcp_cmd = buf[4];

        match kcp_cmd {
            81 => {
                // 81 即 IKCP_CMD_PUSH：真实画面/数据帧，放行至解密和上层 Codec 管道
                ClassifiedPacket::EncryptedPayload(buf)
            }
            // KCP 所有的控制命令字（如 82: ACK, 83: WASK, 84: WINS）均不等于 81，直接短路隔离
            _ => ClassifiedPacket::KcpControl(buf),
        }
    }
}
