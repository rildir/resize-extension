/**
 * PageEraser Chrome Extension — Clippy Contextual Floating Assistant
 *
 * Implements Clippy as an interactive buddy in the corner of the popup,
 * providing contextual speech bubbles, winks, and tips.
 */

const ClippyAssistant = {
  buddyEl: null,
  bubbleEl: null,
  textEl: null,
  spriteEl: null,
  hideTimeout: null,
  enabled: true,
  
  tips: {
    en: [
      "It looks like you are trying to erase an element. Would you like some help with that?",
      "Tip: You can use the 'Alt+Shift+E' key combination to toggle selection mode without opening the popup!",
      "Tip: Pressing 'Alt' while clicking an element stretches it to 100% width instead of hiding it!",
      "Tip: Press 'Ctrl+Z' on the web page to instantly undo your last erased element.",
      "Tip: Use the inline 'Edit' button to fine-tune your CSS selectors if PageEraser hides too much!",
      "Nostalgia Fact: Microsoft Clippy was introduced in Office 97. We saved him from retirement!",
      "Tip: If you uncheck 'Persist', your erasures are temporary and disappear on page reload!",
      "Tip: Check 'Apply to Subdomains' in Options if you want your rules to work across all subdomains of a website.",
      "Did you know? Clicking the tiny screen of the retro computer in the About dialog launches Minesweeper!"
    ],
    tr: [
      "Görünüşe göre bir elementi silmeye çalışıyorsunuz. Bu konuda yardım ister misiniz?",
      "İpucu: Popup'ı açmadan seçim modunu başlatmak için 'Alt+Shift+E' tuş kombinasyonunu kullanabilirsiniz!",
      "İpucu: Seçim modunda bir elemana 'Alt' tuşuna basarak tıklarsanız, onu gizlemek yerine tam genişliğe sığdırır!",
      "İpucu: Sayfada son sildiğiniz elemanı anında geri getirmek için 'Ctrl+Z' kısayolunu kullanabilirsiniz.",
      "İpucu: PageEraser çok fazla alan gizlerse, CSS seçicinizi ince ayarlamak için kural listesindeki 'Düzenle' butonunu kullanın!",
      "Nostalji Bilgisi: Microsoft Clippy ilk olarak Office 97 ile hayatımıza girdi. Onu emeklilikten kurtardık!",
      "İpucu: 'Kalıcı' onay kutusunu kaldırarak yaptığınız gizlemeleri geçici kılabilirsiniz. Sayfa yenilenince geri gelirler!",
      "İpucu: Kurallarınızın sitenin tüm alt alan adlarında geçerli olması için Seçenekler'den 'Alt Alan Adlarında Uygula'yı açabilirsiniz.",
      "Biliyor muydunuz? Hakkında penceresindeki retro bilgisayarın küçük ekranına tıklamak Mayın Tarlası oyununu başlatır!"
    ]
  },

  contextualTips: {
    en: {
      selectBtn: "Start selecting and erasing elements on the page!",
      persistChk: "If checked, hidden elements are saved permanently. If unchecked, they restore on refresh.",
      resetBtn: "Restore all hidden elements on this site to their original state.",
      filterInput: "Type here to filter through your modified elements list.",
      menuSounds: "Toggle the classic Windows 8-bit sound effects.",
      menuScope: "Apply hidden element rules to all subdomains (e.g. *.site.com) instead of just this sub-host.",
      menuAbout: "Learn more about PageEraser, developers, or find hidden easter eggs!",
      menuTour: "Take a quick guided tour of PageEraser controls.",
      rulesItem: "Use 'Edit' to fine-tune the selector, or 'Restore' to bring it back.",
      maximizeDeny: "I'm already as big as I can be! This is a popup, not a mansion."
    },
    tr: {
      selectBtn: "Sayfa üzerindeki elementleri seçip gizlemeye başlamak için tıklayın!",
      persistChk: "Kutuyu kaldırırsanız gizlemeler geçici olur, sayfa yenilenince geri gelir.",
      resetBtn: "Bu sitede gizlediğiniz tüm elementleri tek tıkla geri yükleyin.",
      filterInput: "Gizlenen elementler listesini aramak için yazın.",
      menuSounds: "Klasik retro 8-bit ses efektlerini açıp kapatın.",
      menuScope: "Kuralların sadece bu alt sunucuda değil, tüm alt alan adlarında (subdomain) çalışmasını sağlar.",
      menuAbout: "PageEraser geliştiricileri hakkında bilgi edinin veya sürpriz yumurtaları keşfedin!",
      menuTour: "Kontroller hakkında 3 adımlı kısa bir tura katılın.",
      rulesItem: "Seçiciyi düzeltmek için 'Düzenle'ye, geri getirmek için 'Geri Yükle'ye tıklayın.",
      maximizeDeny: "Zaten olabildiğim kadar büyüğüm! Burası popup, saray değil."
    }
  },
  
  currentTipIndex: 0,

  init() {
    this.buddyEl = document.getElementById('clippy-buddy');
    this.bubbleEl = document.getElementById('clippy-bubble');
    this.textEl = document.getElementById('clippy-text');
    this.spriteEl = document.getElementById('clippy-click-target');

    // Clippy click winks and speaks a random quote
    this.spriteEl.addEventListener('click', () => {
      this.wink();
      RetroAudio.playMinesweeperClick();
      this.showRandomTip();
    });

    // Welcome user on open
    setTimeout(() => {
      const isTr = typeof currentLang !== 'undefined' ? currentLang === 'tr' : navigator.language.startsWith('tr');
      const welcomeMsg = isTr 
        ? "PageEraser'a hoş geldiniz! Size yardımcı olmak için buradayım. Öğrenmek için fareyi butonların üzerine getirin!" 
        : "Welcome to PageEraser! Hover over buttons to learn how they work.";
      this.speak(welcomeMsg, 5000);
    }, 400);
  },

  setEnabled(isEnabled) {
    this.enabled = isEnabled;
    if (!this.buddyEl) return;
    
    if (isEnabled) {
      this.buddyEl.style.setProperty('display', 'flex', 'important');
      const isTr = typeof currentLang !== 'undefined' ? currentLang === 'tr' : navigator.language.startsWith('tr');
      const welcomeMsg = isTr 
        ? "PageEraser'a hoş geldiniz! Size yardımcı olmak için buradayım. Öğrenmek için fareyi butonların üzerine getirin!" 
        : "Welcome to PageEraser! Hover over buttons to learn how they work.";
      this.speak(welcomeMsg, 5000);
    } else {
      this.buddyEl.style.setProperty('display', 'none', 'important');
      if (this.bubbleEl) {
        this.bubbleEl.classList.remove('visible');
      }
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
      }
    }
  },

  speak(text, duration = 3500) {
    if (!this.enabled) return;
    if (!this.bubbleEl || !this.textEl) return;
    
    // Clear existing timeout
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }

    this.textEl.textContent = text;
    this.bubbleEl.classList.add('visible');
    
    // Auto hide speech bubble
    this.hideTimeout = setTimeout(() => {
      this.bubbleEl.classList.remove('visible');
    }, duration);
  },

  showRandomTip() {
    const lang = typeof currentLang !== 'undefined' ? currentLang : 'en';
    const tipList = this.tips[lang] || this.tips.en;
    // Get a random tip index different from current one
    let newIndex = Math.floor(Math.random() * tipList.length);
    if (newIndex === this.currentTipIndex) {
      newIndex = (newIndex + 1) % tipList.length;
    }
    this.currentTipIndex = newIndex;
    this.speak(tipList[newIndex], 5000);
  },

  triggerMenuInteraction() {
    if (!this.enabled) {
      this.setEnabled(true);
      chrome.storage.local.set({ pe_clippy_enabled: true });
      const toggleEl = document.getElementById('menu-item-clippy-toggle');
      if (toggleEl) {
        toggleEl.classList.add('checked');
      }
    }
    this.wink();
    this.showRandomTip();
  },

  wink() {
    const paperclip = this.spriteEl.querySelector('.clippy-paperclip');
    if (paperclip) {
      paperclip.classList.add('wink');
      setTimeout(() => {
        paperclip.classList.remove('wink');
      }, 200);
    }
  },

  handleHover(elementKey) {
    if (!this.enabled) return;
    const lang = typeof currentLang !== 'undefined' ? currentLang : 'en';
    const dict = this.contextualTips[lang] || this.contextualTips.en;
    if (dict[elementKey]) {
      this.speak(dict[elementKey], 3500);
    }
  }
};
