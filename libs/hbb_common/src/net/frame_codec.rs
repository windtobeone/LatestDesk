// hbb_common/src/net/frame_codec.rs
// 🌟 零状态防线：基于 UDP/QUIC 数据包物理边界的无状态帧解码器

use bytes::{Buf, BytesMut};
use std::io;
use tokio_util::codec::Decoder;

#[derive(Default, Debug, Clone, Copy)]
pub struct FrameBoundedCodec;

impl Decoder for FrameBoundedCodec {
    type Item = BytesMut;
    type Error = io::Error;

    /// 🚀 绝对无状态解码：利用包物理边界进行原子切割，0 状态悬挂风险！
    #[inline(always)]
    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, io::Error> {
        if src.is_empty() {
            return Ok(None);
        }

        let total_len = src.len();

        // 1. 读取包头前置的变长 Length
        let head_len = ((src[0] & 0x3) + 1) as usize;
        if total_len < head_len {
            return Ok(None); // 长度不足包头
        }

        // 2. 解析载荷实际大小
        let mut payload_len = src[0] as usize;
        if head_len > 1 {
            payload_len |= (src[1] as usize) << 8;
        }
        if head_len > 2 {
            payload_len |= (src[2] as usize) << 16;
        }
        if head_len > 3 {
            payload_len |= (src[3] as usize) << 24;
        }
        payload_len >>= 2;

        // 3. 🛡️ 【刚性防溢出熔断】：锁死包大小上限（10MB），扼杀假包造成的内存泄露
        if payload_len > 10 * 1024 * 1024 {
            src.clear(); // 物理清空，彻底熔断
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Packet length overflow",
            ));
        }

        // 4. 【原子切割】：必须满足整包物理大小才执行切割
        if total_len < head_len + payload_len {
            return Ok(None);
        }

        src.advance(head_len);
        let payload = src.split_to(payload_len);

        Ok(Some(payload))
    }
}
