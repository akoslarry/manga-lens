# -*- coding: utf-8 -*-
"""
MangaLens 图片预处理模块
- 在图片底部添加横向文本锚点，诱导 OCR 使用正确方向
- 过滤掉 OCR 结果中的锚点文本
"""

import base64
import io
import re
from PIL import Image, ImageDraw, ImageFont

# 锚点文本（使用特殊标记，方便过滤）
ANCHOR_TEXT = "<この画像は横方向です>"

def add_direction_anchor(image_path=None, image_base64=None, output_path=None):
    """
    在图片底部添加横向文本作为方向锚点
    
    Args:
        image_path: 输入图片路径
        image_base64: 输入图片的 Base64 编码
        output_path: 输出图片路径（可选）
    
    Returns:
        dict: {
            "success": bool,
            "image_base64": 处理后的图片 Base64,
            "output_path": 输出文件路径（如果指定）,
            "error": None or str
        }
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
        
        # 加载图片
        if image_path:
            img = Image.open(image_path)
        elif image_base64:
            img_data = base64.b64decode(image_base64)
            img = Image.open(io.BytesIO(img_data))
        else:
            return {"success": False, "error": "必须提供 image_path 或 image_base64"}
        
        # 获取图片尺寸
        width, height = img.size
        
        # 字体大小（根据图片宽度调整）
        font_size = max(20, int(width / 40))
        
        # 文本高度
        text_height = int(font_size * 2)
        
        # 创建新图片（增加底部空间）
        new_height = height + text_height + 20
        new_img = Image.new('RGB', (width, new_height), (255, 255, 255))
        
        # 粘贴原图
        new_img.paste(img, (0, 0))
        
        # 绘制文本
        draw = ImageDraw.Draw(new_img)
        
        # 尝试加载字体（使用默认字体作为后备）
        try:
            font = ImageFont.truetype("msyh.ttc", font_size)  # Windows 微软雅黑
        except:
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", font_size)  # macOS
            except:
                font = ImageFont.load_default()
        
        # 计算文本位置（底部居中）
        bbox = draw.textbbox((0, 0), ANCHOR_TEXT, font=font)
        text_width = bbox[2] - bbox[0]
        text_x = (width - text_width) // 2
        text_y = height + 10
        
        # 绘制白色背景矩形
        bg_padding = 5
        draw.rectangle(
            [text_x - bg_padding, text_y - bg_padding,
             text_x + text_width + bg_padding, text_y + font_size + bg_padding],
            fill=(255, 255, 255)
        )
        
        # 绘制文本
        draw.text((text_x, text_y), ANCHOR_TEXT, fill=(0, 0, 0), font=font)
        
        # 保存或返回
        if output_path:
            new_img.save(output_path, quality=95)
            return {"success": True, "output_path": output_path}
        else:
            # 返回 Base64
            buffer = io.BytesIO()
            new_img.save(buffer, format='PNG')
            return {
                "success": True,
                "image_base64": base64.b64encode(buffer.getvalue()).decode('utf-8'),
                "original_size": (width, height),
                "new_size": (width, new_height)
            }
    
    except ImportError as e:
        return {"success": False, "error": f"缺少依赖库: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def filter_anchor_text(ocr_result):
    """
    从 OCR 结果中过滤掉锚点文本
    
    Args:
        ocr_result: OCR 识别结果 dict
    
    Returns:
        dict: 过滤后的 OCR 结果
    """
    if isinstance(ocr_result, dict):
        texts = ocr_result.get("texts", [])
        filtered_texts = [
            item for item in texts
            if ANCHOR_TEXT not in item.get("text", "")
        ]
        return {
            **ocr_result,
            "texts": filtered_texts,
            "filtered_count": len(texts) - len(filtered_texts)
        }
    return ocr_result


# 测试
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
        output_path = sys.argv[2] if len(sys.argv) > 2 else None
        
        print(f"处理图片: {input_path}")
        result = add_direction_anchor(image_path=input_path, output_path=output_path)
        
        if result["success"]:
            print(f"✅ 处理成功!")
            if "image_base64" in result:
                print(f"   原始尺寸: {result['original_size']}")
                print(f"   新尺寸: {result['new_size']}")
            if "output_path" in result:
                print(f"   输出: {result['output_path']}")
        else:
            print(f"❌ 处理失败: {result['error']}")
    else:
        print("用法: python image_preprocessor.py <输入图片> [输出图片]")
        print(f"锚点文本: {ANCHOR_TEXT}")
