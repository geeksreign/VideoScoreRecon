import cv2
from pathlib import Path
from score_detect import find_score_rect, crop_score

REPO = Path(__file__).resolve().parents[2]
SRC_DIR = REPO / 'data' / 'pic_exp'
OUT_DIR = REPO / 'data' / 'pic_exp_out'


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    images = sorted(SRC_DIR.glob('*.png'))
    if not images:
        print(f"未找到测试图片: {SRC_DIR}")
        return 1

    ok = fail = 0
    for img_path in images:
        bgr = cv2.imread(str(img_path))
        rect = find_score_rect(bgr)
        if rect is None:
            print(f"[FAIL] {img_path.name}: find_score_rect 未检测到曲谱区域")
            fail += 1
            continue
        crop = crop_score(bgr, rect)
        if crop is None:
            print(f"[FAIL] {img_path.name}: crop_score 返回 None (rect={rect})")
            fail += 1
            continue
        out_path = OUT_DIR / (img_path.stem + '.jpg')
        cv2.imwrite(str(out_path), crop)
        print(f"[OK]   {img_path.name}: rect={rect} -> {out_path} ({crop.shape[1]}x{crop.shape[0]})")
        ok += 1

    print(f"\n结果: {ok} 成功, {fail} 失败")
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
