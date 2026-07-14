/**
 * PageEraser Chrome Extension — Spotlight Tour / Onboarding
 *
 * Controls the step-by-step UI walkthrough.
 */
const SpotlightTour = {
  storage: chrome.storage.local || chrome.storage.sync,
  currentStep: 0,
  steps: [
    { selector: '#btn-select', messageKey: 'tourStep1' },
    { selector: '.list-section', messageKey: 'tourStep2' },
    { selector: '.win-fieldset', messageKey: 'tourStep3' }
  ],
  
  init() {
    this.overlay = document.getElementById('tour-overlay');
    this.spotlight = document.getElementById('tour-spotlight');
    this.tooltip = document.getElementById('tour-tooltip');
    this.stepText = document.getElementById('tour-step-text');
    this.progress = document.getElementById('tour-progress');
    this.btnSkip = document.getElementById('btn-tour-skip');
    this.btnPrev = document.getElementById('btn-tour-prev');
    this.btnNext = document.getElementById('btn-tour-next');

    // Bind event listeners
    this.btnSkip.addEventListener('click', () => {
      RetroAudio.playSelection();
      this.end();
    });
    
    this.btnPrev.addEventListener('click', () => {
      if (this.currentStep > 0) {
        RetroAudio.playSelection();
        this.currentStep--;
        this.update();
      }
    });
    
    this.btnNext.addEventListener('click', () => {
      RetroAudio.playSelection();
      if (this.currentStep < this.steps.length - 1) {
        this.currentStep++;
        this.update();
      } else {
        this.end();
      }
    });

    // Keyboard controls
    document.addEventListener('keydown', (e) => {
      if (this.overlay.style.display !== 'block') return;

      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        this.btnNext.click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!this.btnPrev.disabled) {
          this.btnPrev.click();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.btnSkip.click();
      }
    });
  },

  start() {
    this.currentStep = 0;
    this.overlay.style.display = 'block';
    this.update();
  },

  update() {
    if (this.currentStep < 0 || this.currentStep >= this.steps.length) {
      this.end();
      return;
    }
    
    const step = this.steps[this.currentStep];
    const targetEl = document.querySelector(step.selector);
    
    // Translation strings
    const lang = typeof currentLang !== 'undefined' ? currentLang : 'en';
    this.stepText.textContent = LOCALES[lang][step.messageKey];
    this.progress.textContent = `${this.currentStep + 1}/${this.steps.length}`;
    
    this.btnPrev.disabled = (this.currentStep === 0);
    this.btnNext.querySelector('span').textContent = 
      (this.currentStep === this.steps.length - 1) ? LOCALES[lang].finish : LOCALES[lang].next;
    
    if (!targetEl) {
      this.spotlight.style.display = 'none';
      this.tooltip.style.top = '50%';
      this.tooltip.style.left = '50%';
      this.tooltip.style.transform = 'translate(-50%, -50%)';
      this.tooltip.classList.remove('arrow-top', 'arrow-bottom');
      return;
    }
    
    this.spotlight.style.display = 'block';
    this.tooltip.style.transform = '';
    
    requestAnimationFrame(() => {
      const rect = targetEl.getBoundingClientRect();
      const padding = 3;
      
      this.spotlight.style.top = `${rect.top - padding}px`;
      this.spotlight.style.left = `${rect.left - padding}px`;
      this.spotlight.style.width = `${rect.width + padding * 2}px`;
      this.spotlight.style.height = `${rect.height + padding * 2}px`;
      
      const tooltipWidth = 240;
      const tooltipHeight = this.tooltip.offsetHeight;
      const bodyWidth = document.body.clientWidth;
      const bodyHeight = document.body.clientHeight;
      
      let tooltipLeft = rect.left + (rect.width - tooltipWidth) / 2;
      tooltipLeft = Math.max(6, Math.min(tooltipLeft, bodyWidth - tooltipWidth - 6));
      
      const targetCenterY = rect.top + rect.height / 2;
      let tooltipTop;
      
      this.tooltip.classList.remove('arrow-top', 'arrow-bottom');
      
      if (targetCenterY < bodyHeight / 2) {
        tooltipTop = rect.bottom + 8;
        this.tooltip.classList.add('arrow-top');
      } else {
        tooltipTop = rect.top - tooltipHeight - 8;
        this.tooltip.classList.add('arrow-bottom');
      }
      
      const relativeTargetCenter = (rect.left + rect.width / 2) - tooltipLeft;
      const arrowLeft = Math.max(12, Math.min(relativeTargetCenter - 6, tooltipWidth - 18));
      this.tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
      
      this.tooltip.style.top = `${tooltipTop}px`;
      this.tooltip.style.left = `${tooltipLeft}px`;
    });
  },

  end() {
    this.overlay.style.display = 'none';
    this.storage.set({ pe_tour_completed: true });
  }
};
