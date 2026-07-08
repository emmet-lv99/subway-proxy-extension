document.addEventListener('DOMContentLoaded', () => {
  // 명세에 맞춘 기본 설정값 구성
  const defaultSettings = {
    stationName: "강남",
    targetStationOffset: 2,
    updnLine: "0", 
    monitoringDays: [1, 2, 3, 4, 5],
    peakStartHour: 19,
    peakEndHour: 22
  };

  // 1. 기존 데이터 로드 및 UI 컴포넌트 바인딩
  chrome.storage.local.get([
    'stationName', 
    'targetStationOffset', 
    'updnLine', 
    'monitoringDays', 
    'peakStartHour', 
    'peakEndHour'
  ], (result) => {
    
    // 데이터 복원 (기존 저장값이 없으면 안전하게 기본값 선택)
    document.getElementById('station-name').value = result.stationName ?? defaultSettings.stationName;
    document.getElementById('target-offset').value = result.targetStationOffset ?? defaultSettings.targetStationOffset;
    
    const updnValue = result.updnLine ?? defaultSettings.updnLine;
    document.querySelector(`input[name="updn-line"][value="${updnValue}"]`).checked = true;

    const days = result.monitoringDays ?? defaultSettings.monitoringDays;
    document.querySelectorAll('input[name="day"]').forEach((cb) => {
      cb.checked = days.includes(parseInt(cb.value, 10));
    });

    document.getElementById('start-hour').value = result.peakStartHour ?? defaultSettings.peakStartHour;
    document.getElementById('end-hour').value = result.peakEndHour ?? defaultSettings.peakEndHour;
  });
});

// 2. 저장 버튼 이벤트 처리
document.getElementById('save-btn').addEventListener('click', () => {
  const stationName = document.getElementById('station-name').value.trim();
  const targetStationOffset = parseInt(document.getElementById('target-offset').value, 10);
  const updnLine = document.querySelector('input[name="updn-line"]:checked').value;

  const checkedDays = [];
  document.querySelectorAll('input[name="day"]:checked').forEach((cb) => {
    checkedDays.push(parseInt(cb.value, 10));
  });

  const startHour = parseInt(document.getElementById('start-hour').value, 10);
  const endHour = parseInt(document.getElementById('end-hour').value, 10);

  // 유효성 검증 예외 처리
  if (!stationName) {
    showStatusMessage('❌ 퇴근역 이름을 입력해 주세요.', '#ef4444');
    return;
  }
  if (startHour >= endHour) {
    showStatusMessage('❌ 시작 시간은 종료 시간보다 빨라야 합니다.', '#ef4444');
    return;
  }

  // 3. chrome.storage.local 통합 동기화 저장
  chrome.storage.local.set({
    stationName,
    targetStationOffset,
    updnLine,
    monitoringDays: checkedDays,
    peakStartHour: startHour,
    peakEndHour: endHour
  }, () => {
    showStatusMessage('✅ 설정이 성공적으로 저장되었습니다.', '#2eb875');
  });
});

// 피드백 알림 헬퍼 함수
function showStatusMessage(text, color) {
  const statusMsg = document.getElementById('status-msg');
  statusMsg.style.color = color;
  statusMsg.textContent = text;
  setTimeout(() => { statusMsg.textContent = ''; }, 2000);
}