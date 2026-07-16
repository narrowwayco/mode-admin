const DEV_API_URL = "https://w3e145ynx4.execute-api.ap-northeast-2.amazonaws.com";
const PROD_API_URL = "https://api.narrowroad-model.com";

// `npm run dev`(로컬) 또는 `vite build --mode development`(dev 배포)면 dev 게이트웨이 사용
export const API_BASE_URL = import.meta.env.DEV ? DEV_API_URL : PROD_API_URL;

// 프로토콜 없이 호스트명만 필요한 곳(예: 생체인증 자격증명 저장소 식별자)용
export const API_HOST = new URL(API_BASE_URL).host;
