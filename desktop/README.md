# 데스크톱 개발과 패키지

Node.js 22 LTS 최신 패치와 npm을 준비합니다. 저장소 루트에서 실행합니다.

```sh
npm ci
npm run desktop:build
npm run desktop
```

macOS·Linux에서는 파일 검사 도구 빌드에 `clang`이 필요합니다. 계정·서버 주소·작업 폴더는 앱 설정에서 지정합니다. 기본 서버 주소는 `http://localhost:3000`입니다.

## 설치 파일 만들기

대상 운영체제에서 실행합니다.

```sh
# macOS Apple Silicon
npm run package:app -- --mac dmg --arm64 --publish never

# Windows x64
npm run package:app -- --win nsis --x64 --publish never
```

결과는 `release/`에 생성됩니다. macOS는 임시 서명을 사용합니다. 공개 저장소에 완성된 설치 파일은 포함하지 않습니다. 운영자가 설치·삭제·로그인·알림을 대상 PC에서 확인한 뒤 서버의 `app-downloads/`에 배치해야 합니다.

업데이트는 연결한 서버의 `/downloads/apps/`에서 확인합니다. `package.json`의 배포 URL은 로컬 예시이므로 실제 배포 시 운영 서버 주소로 설정합니다. Windows 자동 업데이트는 사용자의 재시작 선택과 데몬 작업 상태 확인을 거칩니다. macOS 정식 자동 교체에는 별도 서명 구성이 필요합니다.
