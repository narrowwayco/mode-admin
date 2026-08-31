import {apiGet} from "../api/apiHelpers.ts";
import {getStoredUser} from "../utils/userStorage.ts";
import {renderBarcodeToCanvas} from "../utils/barcode.ts";
import { IMAGE_BASE_URL } from "../config/apiConfig.ts";
import html2canvas from "html2canvas";

let allCoupons: any[] = [];
let searchTimeout: NodeJS.Timeout | null = null;
let userInfo: any = null;

let pageKeys: any[] = [];
let totalItems = 0;
let currentPage = 1;
const pageLimit = 20;

type CouponVisualType = "MENU" | "FIXED" | "PERCENT";

const COUPON_OVERLAY_IMAGE_BY_TYPE: Partial<Record<CouponVisualType, string>> = {
    FIXED: "/img/coupon-fixed-01.png",
    PERCENT: "/img/coupon-percent-01.png",
};

function getCouponVisualType(couponData: any): CouponVisualType {
    const rawType = String(
        couponData?.discountType
        ?? couponData?.discount_type
        ?? couponData?.couponType
        ?? couponData?.coupon_type
        ?? couponData?.type
        ?? couponData?.campaign?.discountType
        ?? couponData?.campaign?.discount_type
        ?? ""
    ).toUpperCase();

    if (["FIXED", "AMOUNT", "FIXED_AMOUNT", "DISCOUNT_AMOUNT"].includes(rawType)) {
        return "FIXED";
    }
    if (["PERCENT", "PERCENTAGE", "RATE", "DISCOUNT_RATE"].includes(rawType)) {
        return "PERCENT";
    }

    const title = String(couponData?.title ?? couponData?.name ?? "");
    if (/금액권|정액/.test(title)) return "FIXED";
    if (/할인율|할인률|정률|\d+\s*%/.test(title)) return "PERCENT";

    if (couponData?.discountRate != null || couponData?.discount_rate != null) {
        return "PERCENT";
    }
    if (couponData?.discountAmount != null || couponData?.discount_amount != null) {
        return "FIXED";
    }
    return "MENU";
}

function updateCouponBackground(couponData: any) {
    const couponImage = document.getElementById("coupon-image") as HTMLImageElement | null;
    if (!couponImage) return;

    const couponType = getCouponVisualType(couponData);
    couponImage.src = "/img/coupon.svg";
    couponImage.alt = couponType === "FIXED"
        ? "정액 할인쿠폰"
        : couponType === "PERCENT" ? "정률 할인쿠폰" : "메뉴 무료쿠폰";
}

function setDiscountCouponImage(couponData: any, title: string): boolean {
    const couponType = getCouponVisualType(couponData);
    const imageUrl = COUPON_OVERLAY_IMAGE_BY_TYPE[couponType];
    if (!imageUrl) return false;

    const couponContentImage = document.querySelector(
        ".coupon-menu-image"
    ) as HTMLImageElement | null;
    if (couponContentImage) {
        couponContentImage.src = imageUrl;
        couponContentImage.alt = title;
    }
    return true;
}

function getCouponDiscountValue(couponData: any): number {
    const rawValues = [
        couponData?.discountValue,
        couponData?.discount_value,
        couponData?.discountAmount,
        couponData?.discount_amount,
        couponData?.discountRate,
        couponData?.discount_rate,
        couponData?.amount,
        couponData?.rate,
        couponData?.value,
        couponData?.campaign?.discountValue,
        couponData?.campaign?.discount_value,
        couponData?.campaign?.discountAmount,
        couponData?.campaign?.discountRate,
        couponData?.campaign?.amount,
        couponData?.campaign?.rate,
    ];

    for (const rawValue of rawValues) {
        const value = Number(rawValue);
        if (rawValue != null && Number.isFinite(value) && value > 0) return value;
    }

    const title = String(couponData?.title ?? couponData?.name ?? "");
    const couponType = getCouponVisualType(couponData);
    const match = couponType === "PERCENT"
        ? title.match(/([\d,.]+)\s*%/)
        : title.match(/([\d,.]+)\s*원/);
    if (!match) return 0;

    const titleValue = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(titleValue) ? titleValue : 0;
}

function getCouponBenefitText(couponData: any): string {
    const couponType = getCouponVisualType(couponData);
    const discountValue = getCouponDiscountValue(couponData);

    if (couponType === "FIXED") {
        return discountValue > 0
            ? `${discountValue.toLocaleString("ko-KR")}원 할인`
            : "정액 할인";
    }
    if (couponType === "PERCENT") {
        return discountValue > 0 ? `${discountValue}% 할인` : "정률 할인";
    }
    return "1잔 무료";
}

export function initCoupon() {
    console.log("✅ coupon.ts 로드됨");

    // localstorage에 저장된 user 정보를 불러옴
    const user = getStoredUser();

    if (!user) {
        window.showToast(`❌ 사용자 정보가 없습니다.`, 3000, "error");
        return;
    }
}

export function initCouponList() {
    console.log("쿠폰 목록 페이지 초기화");

    // 사용자 정보 및 쿠폰 목록 로드
    loadUserInfoAndCoupons();

    // 개발 환경에서는 신형 쿠폰 발행 페이지를 기본으로 사용
    const openCouponDetailBtn = document.getElementById("open-coupon-detail");

    if (openCouponDetailBtn) {
        openCouponDetailBtn.addEventListener("click", function () {
            window.location.href = "/html/couponDetail2.html";
        });
    }

    // 이미지 저장 버튼 이벤트 리스너 추가
    const saveSelectedCouponsBtn = document.getElementById(
        "save-selected-coupons"
    );
    if (saveSelectedCouponsBtn) {
        saveSelectedCouponsBtn.addEventListener(
            "click",
            saveSelectedCouponsAsImages
        );
    }

    // 전체 선택 체크박스 이벤트 리스너 추가
    initSelectAllCheckbox();

    // 검색 기능 초기화
    initSearchFunction();
}

// 사용자 정보와 쿠폰 목록을 동시에 로드 (페이지네이션 적용)
async function loadUserInfoAndCoupons() {
    const user = getStoredUser();
    if (!user) {
        window.showToast("사용자 정보가 없습니다.", 2000, "error");
        return;
    }

    try {
        const [userResponse] = await Promise.all([
            apiGet(`/model_user_setting?func=get-user&userId=${user.userId}`),
        ]);

        if (userResponse.ok) {
            const userData = await userResponse.json();
            userInfo = userData.user;
            console.log("사용자 정보 로드 완료:", userInfo);
        } else {
            console.error("사용자 정보 로드 실패");
        }

        await getCouponList(user.userId);
    } catch (error) {
        console.error("API 호출 오류:", error);
        window.showToast("데이터를 불러오는데 실패했습니다.", 3000, "error");
    }
}

async function getCouponList(userId: string) {
    try {
        let firstApiUrl = `/model_coupon?func=coupon&userId=${userId}`;
        if (searchTerm) {
            firstApiUrl += `&search=${encodeURIComponent(searchTerm)}`;
        }

        if (currentPage > 1 && pageKeys.length > 0) {
            const keyIndex = (currentPage - 1) * 2 - 1;
            if (pageKeys[keyIndex]) {
                firstApiUrl += `&pageKey=${JSON.stringify(pageKeys[keyIndex])}`;
            }
        }

        const firstResponse = await apiGet(firstApiUrl);
        const firstData = await firstResponse.json();

        // 첫 페이지에서만 pageKeys 수집
        if (currentPage === 1) {
            pageKeys = [];
            totalItems = firstData.total || 0;

            // pageKeys 파싱
            if (firstData.pageKeys) {
                try {
                    pageKeys = JSON.parse(firstData.pageKeys);
                    console.log("📋 pageKeys 파싱 결과:", pageKeys);
                } catch (e) {
                    console.error("pageKeys 파싱 실패:", e);
                }
            }
        }

        let secondApiUrl = `/model_coupon?func=coupon&userId=${userId}`;
        if (searchTerm) {
            secondApiUrl += `&search=${encodeURIComponent(searchTerm)}`;
        }

        let needSecondRequest = false;

        if (currentPage === 1) {
            if (pageKeys[0]) {
                secondApiUrl += `&pageKey=${JSON.stringify(pageKeys[0])}`;
                needSecondRequest = true;
            }
        } else {
            const keyIndex = (currentPage - 1) * 2;
            if (pageKeys[keyIndex]) {
                secondApiUrl += `&pageKey=${JSON.stringify(pageKeys[keyIndex])}`;
                needSecondRequest = true;
            }
        }

        if (needSecondRequest) {
            console.log(" 두 번째 API 요청 URL:", secondApiUrl);
            const secondResponse = await apiGet(secondApiUrl);
            if (secondResponse.ok) {
                const secondData = await secondResponse.json();

                const combinedItems = [
                    ...(firstData.items || []),
                    ...(secondData.items || []),
                ];
                allCoupons = combinedItems;
            } else {
                allCoupons = firstData.items || [];
            }
        } else {
            // 두 번째 요청이 불필요한 경우
            allCoupons = firstData.items || [];
        }

        renderCouponTable(allCoupons);
        renderPagination();
    } catch (error) {
        console.error("쿠폰 목록 로드 실패:", error);
        window.showToast("쿠폰 목록을 불러오는데 실패했습니다.", 3000, "error");
    }
}

function renderPagination() {
    const totalPages = Math.ceil(totalItems / pageLimit);

    let paginationContainer = document.getElementById("pagination-container");
    if (!paginationContainer) {
        paginationContainer = document.createElement("div");
        paginationContainer.id = "pagination-container";
        paginationContainer.className = "pagination";

        const tableArea = document.querySelector(".tableArea");
        if (tableArea && tableArea.parentNode) {
            tableArea.parentNode.insertBefore(
                paginationContainer,
                tableArea.nextSibling
            );
        }
    }

    if (totalPages <= 1) {
        paginationContainer.style.display = "none";
        return;
    }

    paginationContainer.style.display = "flex";
    paginationContainer.innerHTML = "";

    const firstBtn = document.createElement("button");
    firstBtn.textContent = "<<";
    firstBtn.className = `pagination-btn ${currentPage === 1 ? "disabled" : ""}`;
    firstBtn.addEventListener("click", () => {
        if (currentPage !== 1) {
            currentPage = 1;
            getCouponList(getStoredUser()?.userId || "");
        }
    });
    paginationContainer.appendChild(firstBtn);

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "<";
    prevBtn.className = `pagination-btn ${currentPage === 1 ? "disabled" : ""}`;
    prevBtn.addEventListener("click", () => {
        if (currentPage > 1) {
            currentPage--;
            getCouponList(getStoredUser()?.userId || "");
        }
    });
    paginationContainer.appendChild(prevBtn);

    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = document.createElement("button");
        pageBtn.textContent = i.toString();

        pageBtn.className = `pagination-btn ${i === currentPage ? "active" : ""}`;
        pageBtn.addEventListener("click", () => {
            currentPage = i;
            getCouponList(getStoredUser()?.userId || "");
        });
        paginationContainer.appendChild(pageBtn);
    }

    const nextBtn = document.createElement("button");
    nextBtn.textContent = ">";
    nextBtn.className = `pagination-btn ${
        currentPage === totalPages ? "disabled" : ""
    }`;
    nextBtn.addEventListener("click", () => {
        if (currentPage < totalPages) {
            currentPage++;
            getCouponList(getStoredUser()?.userId || "");
        }
    });
    paginationContainer.appendChild(nextBtn);

    const lastBtn = document.createElement("button");
    lastBtn.textContent = ">>";
    lastBtn.className = `pagination-btn ${
        currentPage === totalPages ? "disabled" : ""
    }`;
    lastBtn.addEventListener("click", () => {
        if (currentPage !== totalPages) {
            currentPage = totalPages;
            getCouponList(getStoredUser()?.userId || "");
        }
    });
    paginationContainer.appendChild(lastBtn);
}

let searchTerm = "";

function initSearchFunction() {
    const searchInput = document.getElementById(
        "searchCoupon"
    ) as HTMLInputElement;
    const resetBtn = document.getElementById("searchReset") as HTMLButtonElement;

    if (!searchInput || !resetBtn) {
        return;
    }

    // ✅ 검색 버튼 이벤트 리스너 제거

    // 리셋 버튼 클릭 이벤트
    resetBtn.addEventListener("click", () => {
        searchInput.value = "";
        // 실시간 검색으로 전체 데이터 표시
        renderCouponTable(allCoupons, false);
        renderPagination();
    });

    // Enter 키 이벤트
    searchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            // Enter 키도 실시간 검색과 동일하게 처리
            const searchValue = searchInput.value.trim();
            performRealTimeSearch(searchValue);
        }
    });

    // 실시간 검색
    searchInput.addEventListener("input", function () {
        const searchValue = searchInput.value.trim();

        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }

        searchTimeout = setTimeout(() => {
            performRealTimeSearch(searchValue);
        }, 300);
    });
}

//  실시간 검색 실행
async function performRealTimeSearch(searchValue: string) {
    if (!searchValue.trim()) {
        renderCouponTable(allCoupons);
        renderPagination();
        return;
    }

    const koreanConsonants = /^[ㄱ-ㅎ]+$/;
    if (koreanConsonants.test(searchValue)) {
        renderCouponTable(allCoupons);
        renderPagination();
        return;
    }

    if (searchValue.length < 1) {
        renderCouponTable(allCoupons);
        renderPagination();
        return;
    }

    try {
        const user = getStoredUser();
        if (!user) return;

        const isKorean = /[가-힣]/.test(searchValue);
        const isNumber = /^\d+$/.test(searchValue);

        let apiUrl = `/model_coupon?func=couponDetail&userId=${user.userId}`;

        if (isKorean) {
            apiUrl += `&title=${encodeURIComponent(searchValue)}`;
        } else if (isNumber) {
            apiUrl += `&couponCode=${searchValue}`;
        }

        const response = await apiGet(apiUrl);
        if (response.ok) {
            const data = await response.json();
            const searchResults = data.items || [];

            renderCouponTable(searchResults, true);

            // ✅ 검색 중에는 페이지네이션 숨기기
            const paginationContainer = document.getElementById(
                "pagination-container"
            );
            if (paginationContainer) {
                paginationContainer.style.display = "none";
            }
        } else {
            renderCouponTable(allCoupons, false);
            renderCouponTable(allCoupons);
            renderPagination();
        }
    } catch (error) {
        renderCouponTable(allCoupons);
        renderPagination();
    }
}

// 검색 실행 (수정)
/*
function performSearch(searchValue: string) {
  console.log("검색 실행:", searchValue);

  searchTerm = searchValue;
  currentPage = 1;

  const user = getStoredUser();
  if (user) {
    getCouponList(user.userId);
  }
}
*/

// 전체 선택 체크박스 초기화
function initSelectAllCheckbox() {
    const selectAllCheckbox = document.querySelector(
        'thead input[type="checkbox"]'
    ) as HTMLInputElement;

    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener("change", function () {
            const isChecked = this.checked;
            const dataCheckboxes = document.querySelectorAll(
                'tbody input[type="checkbox"]'
            ) as NodeListOf<HTMLInputElement>;

            dataCheckboxes.forEach((checkbox) => {
                checkbox.checked = isChecked;
            });
        });
    }
}

// 개별 체크박스 상태에 따른 전체 선택 체크박스 상태 업데이트
function updateSelectAllCheckbox() {
    const selectAllCheckbox = document.querySelector(
        'thead input[type="checkbox"]'
    ) as HTMLInputElement;
    const dataCheckboxes = document.querySelectorAll(
        'tbody input[type="checkbox"]'
    ) as NodeListOf<HTMLInputElement>;

    if (selectAllCheckbox && dataCheckboxes.length > 0) {
        const checkedCount = Array.from(dataCheckboxes).filter(
            (checkbox) => checkbox.checked
        ).length;

        if (checkedCount === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (checkedCount === dataCheckboxes.length) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        }
    }
}

// 쿠폰 테이블 렌더링
function renderCouponTable(coupons: any[], isSearchResult: boolean = false) {
    const tbody = document.getElementById("coupon-table-body");

    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    if (!coupons || coupons.length === 0) {
        const emptyRow = document.createElement("tr");
        emptyRow.innerHTML = `
      <td colspan="6" class="text-center">발급된 쿠폰이 없습니다.</td>
    `;
        tbody.appendChild(emptyRow);
        return;
    }

    console.log("coupons :", coupons);

    coupons.forEach((coupon, index) => {
        const row = document.createElement("tr");
        row.classList.add("coupon-row");
        row.setAttribute("data-coupon-index", index.toString());

        const formatDate = (dateString: string) => {
            const date = new Date(dateString);
            const year = String(date.getFullYear()).slice(-2);
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            return `${year}.${month}.${day}`;
        };

        const expiresAt = formatDate(coupon.expiresAt);
        const displayTitle = coupon.title.replace(" 무료", "");

        const useYn = coupon.count === 0 ? '사용' : '미사용';
        // ✅ 검색 결과인지에 따라 번호 계산 방식 변경
        const itemNumber = isSearchResult
            ? index + 1
            : (currentPage - 1) * pageLimit + index + 1;

        row.innerHTML = `
      <td><input type="checkbox" /></td>
      <td>${itemNumber}</td>
      <td>${displayTitle}</td>
      <td>~${expiresAt}</td>
      <td>${coupon.couponCode}</td>
      <td>${useYn}</td>
    `;

        tbody.appendChild(row);

        // 개별 체크박스 이벤트 리스너 추가
        const checkbox = row.querySelector(
            'input[type="checkbox"]'
        ) as HTMLInputElement;
        if (checkbox) {
            checkbox.addEventListener("change", updateSelectAllCheckbox);
            // 체크박스 클릭 시 이벤트 전파 방지
            checkbox.addEventListener("click", (e) => {
                e.stopPropagation();
            });
        }

        row.addEventListener("click", () => {
            showCouponPopup(coupon);
        });
    });

    // 테이블 렌더링 후 전체 선택 체크박스 상태 초기화
    updateSelectAllCheckbox();

    // 팝업 닫기 이벤트 리스너 추가
    initCouponPopupEvents();
}

function showCouponPopup(couponData: any) {
    const popup = document.getElementById("coupon-popup") as HTMLElement;

    if (popup) {
        updateCouponOverlay(couponData);
        popup.style.display = "flex";
    }
}

// 메뉴 이미지 로드 함수
function isValidMenuId(menuId: unknown): boolean {
    if (menuId === null || menuId === undefined || menuId === "") return false;
    return Number.isFinite(Number(menuId));
}

async function loadMenuImage(menuId: string, title: string) {
    try {
        if (!isValidMenuId(menuId)) {
            console.warn("메뉴 이미지 조회 생략: 유효한 menuId가 없습니다.", menuId);
            return;
        }
        const user = getStoredUser();
        if (!user) return;

        const response = await apiGet(
            `/model_admin_menu?userId=${user.userId}&menuId=${menuId}&func=get-menu-by-id`
        );

        if (response.ok) {
            const data = await response.json();

            if (data.image) {
                const imageFile = data.image?.split("\\").pop() ?? "";
                const encodedFile = encodeURIComponent(imageFile);
                const imageUrl = data.imageUrl || `${IMAGE_BASE_URL}/model/${data.userId}/${encodedFile}`;

                const menuImage = document.querySelector(
                    ".coupon-menu-image"
                ) as HTMLImageElement;
                if (menuImage) {
                    menuImage.src = imageUrl;
                    menuImage.alt = title;
                    console.log("메뉴 이미지 로드 완료:", imageUrl);
                }
            }
        }
    } catch (error) {
        console.error("메뉴 이미지 로드 실패:", error);
    }
}

function updateCouponOverlay(couponData: any) {
    updateCouponBackground(couponData);

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
        const weekday = weekdays[date.getDay()];
        return `${year}-${month}-${day}(${weekday})`;
    };

    const title = couponData.title.replace(" 무료", "");
    const endDate = formatDate(couponData.expiresAt);
    const period = `${endDate}까지`;
    const storeName = userInfo?.storeName || "전체 지점";
    const titleLength = title.length;
    const titleClass = titleLength >= 10 ? "coupon-title small" : "coupon-title";
    const freeClass = titleLength >= 10 ? "coupon-free small" : "coupon-free";
    const benefitText = getCouponBenefitText(couponData);

    const couponOverlay = document.querySelector(
        ".coupon-overlay"
    ) as HTMLElement;
    if (couponOverlay) {
        couponOverlay.innerHTML = ` 
      <div class="coupon-period" style="transform: translateY(-7px);">${period}</div>
      <img class="coupon-menu-image" src="" alt="${title}" style="transform: translateY(-7px);" />
      <div class="${titleClass}" style="transform: translateY(-7px);">${title}</div>
      <div class="${freeClass}" style="transform: translateY(-7px);">${benefitText}</div>
      <div class="coupon-store" style="transform: translateY(-7px);">${storeName}</div>
      <div class="coupon-id" style="transform: translateY(-7px);">${couponData.couponId}</div>
      <canvas id="coupon-barcode" style="transform: translateY(-7px);"></canvas>  
    `;

        // ✅ 메뉴 이미지 로드
        if (!setDiscountCouponImage(couponData, title)) {
            loadMenuImage(couponData.menuId, title);
        }
    }

    setTimeout(() => {
        const barcodeCanvas = document.getElementById(
            "coupon-barcode"
        ) as HTMLCanvasElement;
        if (barcodeCanvas) {
            try {
                renderBarcodeToCanvas(couponData.couponCode, barcodeCanvas);
                console.log("바코드 생성 완료:", couponData.couponCode);
            } catch (error) {
                console.error("바코드 생성 실패:", error);
            }
        }
    }, 100);
}

// 이미지 다운로드 함수 (선택된 쿠폰 저장용으로만 유지)
function downloadURI(uri: string, name: string) {
    const link = document.createElement("a");
    link.download = name;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 쿠폰 팝업 닫기
function hideCouponPopup() {
    const popup = document.getElementById("coupon-popup") as HTMLElement;
    if (popup) {
        popup.style.display = "none";
    }
}

// 팝업 이벤트 초기화
let popupEventsInitialized = false;

function initCouponPopupEvents() {
    if (popupEventsInitialized) return;

    const closeBtn = document.querySelector(
        "#coupon-popup .close-btn"
    ) as HTMLElement;
    const popupOverlay = document.getElementById("coupon-popup") as HTMLElement;

    // 닫기 버튼 클릭
    if (closeBtn) {
        closeBtn.addEventListener("click", hideCouponPopup);
    }

    // 오버레이 클릭 시 닫기
    if (popupOverlay) {
        popupOverlay.addEventListener("click", (e) => {
            if (e.target === popupOverlay) {
                hideCouponPopup();
            }
        });
    }

    popupEventsInitialized = true;
}

async function saveSelectedCouponsAsImages() {
    const checkedCheckboxes = document.querySelectorAll(
        'tbody input[type="checkbox"]:checked'
    ) as NodeListOf<HTMLInputElement>;

    if (checkedCheckboxes.length === 0) {
        window.showToast("저장할 쿠폰을 선택해주세요.", 3000, "warning");
        return;
    }

    console.log(`${checkedCheckboxes.length}개의 쿠폰 이미지 저장 시작`);

    // 로딩 표시
    const saveBtn = document.getElementById(
        "save-selected-coupons"
    ) as HTMLButtonElement;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "저장 중...";
    saveBtn.disabled = true;

    try {
        const selectedIndices: number[] = [];
        checkedCheckboxes.forEach((checkbox) => {
            const row = checkbox.closest("tr") as HTMLElement;
            const index = parseInt(row.getAttribute("data-coupon-index") || "0");
            selectedIndices.push(index);
        });

        const selectedCoupons = selectedIndices
            .map((index) => allCoupons[index])
            .filter(Boolean);

        // 각 쿠폰에 대해 이미지 생성 및 저장
        for (let i = 0; i < selectedCoupons.length; i++) {
            const coupon = selectedCoupons[i];
            console.log(
                `${i + 1}/${selectedCoupons.length} 쿠폰 처리 중: ${coupon.title}`
            );

            // 쿠폰 팝업을 숨겨진 상태로 생성
            await generateCouponImage(coupon);
        }

        window.showToast(
            `${selectedCoupons.length}개의 쿠폰 이미지가 저장되었습니다.`,
            3000,
            "success"
        );

        /*setTimeout(() => {
          window.location.reload();
        }, 1000);*/
    } catch (error) {
        console.error("이미지 저장 실패:", error);
        window.showToast("이미지 저장에 실패했습니다.", 3000, "error");
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
}

// 개별 쿠폰 이미지 생성 함수 수정
async function generateCouponImage(couponData: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
        try {
            const popup = document.getElementById("coupon-popup") as HTMLElement;
            const couponContainer = popup.querySelector(".coupon-container") as HTMLElement;

            // 1️⃣ popup을 완전히 렌더링 가능한 위치에 둠 (숨기지 말고, 화면밖으로만 이동)
            Object.assign(popup.style, {
                display: "flex",
                position: "fixed",
                top: "0", // ❗ 꼭 0
                left: "0",
                transform: "translateY(150%)", // 화면 아래쪽으로 밀기 (렌더링됨)
                opacity: "0", // 안보이게
                zIndex: "9999",
                pointerEvents: "none",
            });

            // 2️⃣ html2canvas는 DOM paint 이후 실행해야 함
            await updateCouponOverlayForCapture(couponData);
            await new Promise((r) => setTimeout(r, 400)); // DOM 업데이트 기다림

            // 3️⃣ 웹폰트가 있다면 반드시 대기
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
            }

            // 4️⃣ 바코드 렌더링
            const barcodeCanvas = document.getElementById("coupon-barcode") as HTMLCanvasElement;
            if (barcodeCanvas) {
                renderBarcodeToCanvas(couponData.couponCode, barcodeCanvas);
            }

            // 5️⃣ 캡처 실행
            const canvas = await html2canvas(couponContainer, {
                useCORS: true,
                allowTaint: false,
                scale: Math.min(window.devicePixelRatio, 1.5),
                backgroundColor: "#ffffff", // iOS용 흰색 배경 필수
                logging: false,
                onclone: (doc) => {
                    // 복제된 DOM에 스타일 보존
                    const clonedPopup = doc.getElementById("coupon-popup");
                    if (clonedPopup) {
                        clonedPopup.style.transform = "none";
                        clonedPopup.style.opacity = "1";
                    }
                },
            });

            // 6️⃣ 둥근 모서리 적용
            const roundedCanvas = document.createElement("canvas");
            const ctx = roundedCanvas.getContext("2d");
            roundedCanvas.width = canvas.width;
            roundedCanvas.height = canvas.height;
            if (ctx) {
                ctx.beginPath();
                ctx.roundRect(0, 0, canvas.width, canvas.height, 12);
                ctx.clip();
                ctx.drawImage(canvas, 0, 0);
            }

            const safeTitle = couponData.title.replace(/[^\w\s가-힣]/g, "").replace(/\s+/g, "_");
            const fileName = `${safeTitle}_${couponData.couponCode}.png`;

            // 7️⃣ 이미지 저장
            downloadURI(roundedCanvas.toDataURL("image/png"), fileName);

            // 8️⃣ popup 복원
            popup.style.transform = "";
            popup.style.opacity = "1";
            popup.style.display = "none";

            resolve();
        } catch (error) {
            reject(error);
        }
    });
}


// 캡처용 오버레이 업데이트 함수
async function updateCouponOverlayForCapture(couponData: any): Promise<void> {
    updateCouponBackground(couponData);

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
        const weekday = weekdays[date.getDay()];
        return `${year}-${month}-${day}(${weekday})`;
    };

    const title = couponData.title.replace(" 무료", "");
    const endDate = formatDate(couponData.expiresAt);
    const period = `${endDate}까지`;
    const storeName = userInfo?.storeName || "전체 지점";
    const titleLength = title.length;
    const titleClass = titleLength >= 10 ? "coupon-title small" : "coupon-title";
    const freeClass = titleLength >= 10 ? "coupon-free small" : "coupon-free";
    const benefitText = getCouponBenefitText(couponData);

    const couponOverlay = document.querySelector(
        ".coupon-overlay"
    ) as HTMLElement;
    if (couponOverlay) {
        couponOverlay.innerHTML = ` 
      <div class="coupon-period" style="transform: translateY(-15px);">${period}</div>
      <img class="coupon-menu-image" src="" alt="${title}" style="transform: translateY(-7px);" />
      <div class="${titleClass}" style="transform: translateY(-7px);">${title}</div>
      <div class="${freeClass}" style="transform: translateY(-7px);">${benefitText}</div>
      <div class="coupon-store" style="transform: translateY(-7px);">${storeName}</div>
      <div class="coupon-id" style="transform: translateY(-7px);">${couponData.couponId}</div>
      <canvas id="coupon-barcode" style="transform: translateY(-7px);"></canvas>  
    `;

        if (!setDiscountCouponImage(couponData, title)) {
            await loadMenuImageForCapture(couponData.menuId, title);
        }
    }
}

// 캡처용 메뉴 이미지 로드 함수
async function loadMenuImageForCapture(
    menuId: string,
    title: string
): Promise<void> {
    return new Promise((resolve) => {
        try {
            if (!isValidMenuId(menuId)) {
                console.warn("캡처용 메뉴 이미지 조회 생략: 유효한 menuId가 없습니다.", menuId);
                resolve();
                return;
            }
            const user = getStoredUser();
            if (!user) {
                console.log("❌ 사용자 정보 없음");
                resolve();
                return;
            }

            console.log("🔍 이미지 로드 시작:", menuId, title);

            apiGet(
                `/model_admin_menu?userId=${user.userId}&menuId=${menuId}&func=get-menu-by-id`
            )
                .then((response) => {
                    if (response.ok) {
                        return response.json();
                    }
                    throw new Error("API 응답 실패");
                })
                .then((data) => {
                    console.log(" API 응답 데이터:", data);

                    if (data.image) {
                        const imageFile = data.image?.split("\\").pop() ?? "";
                        const encodedFile = encodeURIComponent(imageFile);
                        const imageUrl = data.imageUrl || `${IMAGE_BASE_URL}/model/${data.userId}/${encodedFile}`;

                        console.log("🖼️ 이미지 URL:", imageUrl);

                        // ✅ 단순히 이미지 src 설정 (Base64 변환 제거)
                        const menuImage = document.querySelector(
                            ".coupon-menu-image"
                        ) as HTMLImageElement;
                        if (menuImage) {
                            menuImage.src = imageUrl;
                            menuImage.alt = title;
                            console.log("✅ 이미지 설정 완료");
                        } else {
                            console.log("❌ 이미지 요소를 찾을 수 없음");
                        }
                    } else {
                        console.log("❌ 이미지 데이터 없음");
                    }
                    resolve();
                })
                .catch((error) => {
                    console.error("❌ API 호출 실패:", error);
                    resolve();
                });
        } catch (error) {
            console.error("❌ 함수 실행 실패:", error);
            resolve();
        }
    });
}
